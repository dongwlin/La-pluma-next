import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { createLogger } from '../utils/logger.ts';
import { updateTextFile } from '../utils/fileHelper.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';
import { execMaaCommandUnlocked } from './maaProcessService.ts';

/**
 * MAA profile 配置的读取与写入。
 *
 * - 目录与 profile 路径都由 `maa dir config` 解析，名称经同一白名单校验，
 *   拒绝路径穿越。
 * - 同一 profile 的读取、合并与写入在同一排队单元内完成；TOML 内容按文本
 *   原子替换，解析或写入失败时不写回，已有配置保持原样（与既有原子写契约
 *   一致）。
 * - 这里只执行非设备变更的 `dir` 查询，不申请执行租约；进程执行与状态归
 *   maaProcessService。
 */

const logger = createLogger('MaaService');

/**
 * TOML 文档的 JSON 等价形状：表字段的值来自 TOML 解析或 HTTP 请求体，
 * 在写出前保持 unknown，不复制第二套 TOML 值域。
 */
export type MaaProfileDocument = Record<string, unknown>;

/** connection section 的读写形状；字段集合由 MAA profile 决定。 */
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
 * 获取 MAA 配置目录
 */
export async function getMaaConfigDir(): Promise<string> {
  const result = await execMaaCommandUnlocked('dir', ['config']);
  return result.stdout;
}

/**
 * 获取配置文件路径
 */
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

  const normalizedUpdates = Object.fromEntries(
    Object.entries(connectionUpdates).filter(([, value]) => value !== undefined)
  );
  return {
    ...profileDocument,
    connection: {
      ...(existingConnection || {}),
      ...normalizedUpdates
    }
  };
}

/**
 * 读取配置文件
 */
export async function getConfig(profileName: unknown = 'default'): Promise<MaaProfileConnection> {
  const normalizedProfileName = validateMaaProfileName(profileName);
  try {
    const configPath = await getConfigPath(normalizedProfileName);
    const content = await readFile(configPath, 'utf-8');
    const profile = parseMaaProfile(content);
    const connection = profile.connection;
    return isRecord(connection) ? connection : profile;
  } catch {
    logger.debug('配置文件不存在，返回环境默认配置');
    return {
      adb_path: DEFAULT_ADB_PATH,
      address: DEFAULT_ADB_ADDRESS,
      config: 'CompatMac',
    };
  }
}

/**
 * 保存配置文件
 */
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
