import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { createLogger } from '../utils/logger.ts';
import { updateTextFile } from '../utils/fileHelper.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';
import { execMaaCommandUnlocked } from './maaProcessService.ts';

const logger = createLogger('MaaService');

/**
 * TOML 文档的 JSON 等价形状：表字段的值来自 TOML 解析或 HTTP 请求体，
 * 在写出前保持 unknown，不复制第二套 TOML 值域。
 */
export type MaaProfileDocument = Record<string, unknown>;

export type MaaProfileConnection = Record<string, unknown>;

/** TOML 默认导出把文档形状声明为未导出的内部 JsonMap；解析结果与之兼容。 */
const parseToml: (text: string) => MaaProfileDocument = TOML.parse;
/**
 * stringify 的声明参数是内部 JsonMap（数组为同构联合），与运行时接受的
 * 任意表不一致；只在库边界收窄一次，调用方仍按 MaaProfileDocument 使用。
 */
const stringifyToml = TOML.stringify as (document: MaaProfileDocument) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `maa dir config` 的进程内缓存。
 *
 * 配置目录由进程环境决定，一次进程生命周期内不会变化；设备采样等轮询接口
 * 会反复解析连接，没有缓存时每次轮询都会启动一次 CLI。这里保存进行中的
 * 查询本身，让并发请求共享同一次调用；成功结果按进程缓存。
 *
 * 查询失败时清空进行中的 Promise，并在短冷却期内直接返回同一个错误，
 * 避免 CLI 故障时每 5 秒重新 spawn；冷却结束后的下一次调用重新尝试。
 */
const CONFIG_DIR_FAILURE_TTL_MS = 30_000;

let configDirPromise: Promise<string> | null = null;
let configDirFailure: { error: unknown; at: number } | null = null;

export function getMaaConfigDir(): Promise<string> {
  const now = Date.now();
  if (configDirFailure) {
    if (now - configDirFailure.at < CONFIG_DIR_FAILURE_TTL_MS) {
      return Promise.reject(configDirFailure.error);
    }
    configDirFailure = null;
  }
  if (!configDirPromise) {
    // 目录查询是诊断类短命令：静默执行，避免故障期间每次重试都写一条执行日志。
    configDirPromise = execMaaCommandUnlocked('dir', ['config'], null, null, false, true)
      .then(result => result.stdout)
      .catch(error => {
        configDirFailure = { error, at: Date.now() };
        configDirPromise = null;
        throw error;
      });
  }
  return configDirPromise;
}

export function validateMaaProfileName(profileName: unknown = 'default'): string {
  if (typeof profileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName)) {
    throw new Error('连接配置名称不合法');
  }
  return profileName;
}

async function getConfigPath(profileName: unknown = 'default'): Promise<string> {
  const normalizedProfileName = validateMaaProfileName(profileName);
  const configDir = await getMaaConfigDir();
  const profilesDir = resolve(configDir.trim(), 'profiles');
  const configPath = resolve(profilesDir, `${normalizedProfileName}.toml`);
  if (dirname(configPath) !== profilesDir) {
    throw new Error('连接配置路径不合法');
  }
  return configPath;
}

export function parseMaaProfile(content: unknown): MaaProfileDocument {
  return parseToml(String(content || ''));
}

const BEHAVIOR_KEYS = new Set(['auto_reconnect']);

function splitProfileUpdates(updates: Record<string, unknown>): {
  connection: Record<string, unknown>;
  behavior: Record<string, unknown>;
} {
  const connection: Record<string, unknown> = {};
  const behavior: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (BEHAVIOR_KEYS.has(key)) behavior[key] = value;
    else connection[key] = value;
  }
  return { connection, behavior };
}

function toConnectionView(profile: MaaProfileDocument): MaaProfileConnection {
  const connectionSection = profile.connection;
  const connection = isRecord(connectionSection) ? connectionSection : profile;
  const connectionValues: Record<string, unknown> = { ...connection };
  const legacyAutoReconnect = connectionValues.auto_reconnect;
  delete connectionValues.auto_reconnect;
  if (!isRecord(connectionSection)) delete connectionValues.behavior;

  const behavior = isRecord(profile.behavior) ? profile.behavior : null;
  const autoReconnect = typeof behavior?.auto_reconnect === 'boolean'
    ? behavior.auto_reconnect
    : typeof legacyAutoReconnect === 'boolean'
      ? legacyAutoReconnect
      : undefined;
  return autoReconnect === undefined
    ? connectionValues
    : { ...connectionValues, auto_reconnect: autoReconnect };
}

export function mergeMaaProfileConnection(
  profileDocument: unknown = {},
  config: unknown = {}
): MaaProfileDocument {
  if (!isRecord(profileDocument)) {
    throw new TypeError('MAA profile 文档格式不合法');
  }
  if (!isRecord(config)) {
    throw new TypeError('connection 配置格式不合法');
  }

  const connectionUpdates = Object.prototype.hasOwnProperty.call(config, 'connection')
    ? config.connection
    : config;
  if (!isRecord(connectionUpdates)) {
    throw new TypeError('connection 配置格式不合法');
  }

  const existingConnection = profileDocument.connection;
  if (existingConnection != null && !isRecord(existingConnection)) {
    throw new TypeError('现有 connection section 格式不合法');
  }

  const existingBehavior = profileDocument.behavior;
  if (existingBehavior != null && !isRecord(existingBehavior)) {
    throw new TypeError('现有 behavior section 格式不合法');
  }

  const { connection: connectionValues, behavior: behaviorValues } = splitProfileUpdates(connectionUpdates);

  const connection = { ...(existingConnection || {}) };
  const legacyAutoReconnect = connection.auto_reconnect;
  delete connection.auto_reconnect;

  const behavior = { ...(existingBehavior || {}) };
  if (
    !Object.prototype.hasOwnProperty.call(behavior, 'auto_reconnect')
    && typeof legacyAutoReconnect === 'boolean'
  ) {
    behavior.auto_reconnect = legacyAutoReconnect;
  }
  Object.assign(behavior, behaviorValues);

  return {
    ...profileDocument,
    connection: { ...connection, ...connectionValues },
    ...(Object.keys(behavior).length > 0 ? { behavior } : {})
  };
}

export async function getConfig(profileName: unknown = 'default'): Promise<MaaProfileConnection> {
  const normalizedProfileName = validateMaaProfileName(profileName);
  try {
    const configPath = await getConfigPath(normalizedProfileName);
    const content = await readFile(configPath, 'utf-8');
    return toConnectionView(parseMaaProfile(content));
  } catch {
    logger.debug('配置文件不存在，返回环境默认配置');
    return {
      adb_path: DEFAULT_ADB_PATH,
      address: DEFAULT_ADB_ADDRESS,
      config: 'CompatMac',
    };
  }
}

export async function saveConfig(profileName: unknown = 'default', config: unknown): Promise<void> {
  try {
    const normalizedProfileName = validateMaaProfileName(profileName);
    const configPath = await getConfigPath(normalizedProfileName);

    // 同一 profile 的读取、合并与写入在同一排队单元内完成：并发保存不会互相覆盖未知 section，
    // 异名 profile 路径不同、互不阻塞。TOML 内容按文本原子替换；解析或写入失败时不写回，
    // 已有配置保持原样。
    await updateTextFile(configPath, currentContent => {
      const existingProfile = currentContent === null ? {} : parseMaaProfile(currentContent);
      const mergedProfile = mergeMaaProfileConnection(existingProfile, config);
      return stringifyToml(mergedProfile);
    });
    logger.debug('配置已保存', { configPath });
  } catch (error) {
    throw new Error(`保存配置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
