import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { createLogger } from '../utils/logger.ts';
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
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

/**
 * maa-cli `[connection].preset` 的受支持取值；`PlayTools` 是 `PlayCover` 的
 * 旧别名，读取时归一、写出时使用规范名。
 */
export const MAA_CONNECTION_PRESETS = ['ADB', 'MuMuPro', 'PlayCover', 'Waydroid', 'Androws'] as const;
export type MaaConnectionPreset = (typeof MAA_CONNECTION_PRESETS)[number];

/**
 * maa-cli `[instance_options].touch_mode` 的受支持取值；CLI 读取时不区分大小写，
 * 这里统一写规范名。
 */
export const MAA_TOUCH_MODES = ['Adb', 'MiniTouch', 'MaaTouch', 'MacPlayTools', 'MaaFwAdb'] as const;
export type MaaTouchMode = (typeof MAA_TOUCH_MODES)[number];

export interface MaaProfileInstanceOptions extends Record<string, unknown> {
  touch_mode?: MaaTouchMode;
  deployment_with_pause?: boolean;
  adb_lite_enabled?: boolean;
  kill_adb_on_exit?: boolean;
}

/** profile 读取视图：connection 含 `[behavior].auto_reconnect`，实例选项单列一段。 */
export interface MaaProfileView {
  connection: MaaProfileConnection;
  instance_options: MaaProfileInstanceOptions;
}

const CONNECTION_PRESET_ALIASES: Readonly<Record<string, MaaConnectionPreset>> = {
  adb: 'ADB',
  mumupro: 'MuMuPro',
  playcover: 'PlayCover',
  playtools: 'PlayCover',
  waydroid: 'Waydroid',
  androws: 'Androws'
};

const TOUCH_MODE_ALIASES: Readonly<Record<string, MaaTouchMode>> = {
  adb: 'Adb',
  minitouch: 'MiniTouch',
  maatouch: 'MaaTouch',
  macplaytools: 'MacPlayTools',
  maafwadb: 'MaaFwAdb'
};

/** 实例选项已知字段；值域在写入前校验，未知字段按 MAA 前向兼容原样保留。 */
const INSTANCE_OPTION_BOOLEAN_KEYS = [
  'deployment_with_pause',
  'adb_lite_enabled',
  'kill_adb_on_exit'
] as const;

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

function isAgentError(error: unknown): error is AgentError {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { statusCode?: unknown }).statusCode === 'number';
}

function invalidProfileField(field: string, value: unknown): AgentError {
  return agentError('AGENT_CONFIG_PROFILE_INVALID', '连接配置字段不合法', {
    statusCode: 400,
    details: { field, value },
    retryable: false
  });
}

function normalizePreset(value: unknown): MaaConnectionPreset | undefined {
  return typeof value === 'string' ? CONNECTION_PRESET_ALIASES[value.trim().toLowerCase()] : undefined;
}

function normalizeTouchMode(value: unknown): MaaTouchMode | undefined {
  return typeof value === 'string' ? TOUCH_MODE_ALIASES[value.trim().toLowerCase()] : undefined;
}

/** 读取时归一已知字段的别名与大小写；未知值保持原样，由页面按默认值展示。 */
function normalizeConnectionValues(values: Record<string, unknown>): Record<string, unknown> {
  const preset = normalizePreset(values.preset);
  return preset === undefined ? values : { ...values, preset };
}

function normalizeInstanceOptions(values: Record<string, unknown>): Record<string, unknown> {
  const touchMode = normalizeTouchMode(values.touch_mode);
  return touchMode === undefined ? values : { ...values, touch_mode: touchMode };
}

/**
 * 写入前校验 connection 段的已知字段。未知字段与旧版 `device` 别名保持原样，
 * 避免把 MAA profile 里本页不展示的选项丢掉；非法值返回 400 而不是静默落盘。
 */
function validateConnectionUpdates(updates: Record<string, unknown>): void {
  if (updates.preset !== undefined && normalizePreset(updates.preset) === undefined) {
    throw invalidProfileField('connection.preset', updates.preset);
  }
  for (const key of ['adb_path', 'address', 'config']) {
    if (updates[key] !== undefined && typeof updates[key] !== 'string') {
      throw invalidProfileField(`connection.${key}`, updates[key]);
    }
  }
  if (updates.auto_reconnect !== undefined && typeof updates.auto_reconnect !== 'boolean') {
    throw invalidProfileField('connection.auto_reconnect', updates.auto_reconnect);
  }
}

/** 写入前校验 `[instance_options]` 的已知字段；未知字段留给 MaaCore 扩展。 */
function validateInstanceOptionsUpdates(updates: Record<string, unknown>): void {
  if (updates.touch_mode !== undefined && normalizeTouchMode(updates.touch_mode) === undefined) {
    throw invalidProfileField('instance_options.touch_mode', updates.touch_mode);
  }
  for (const key of INSTANCE_OPTION_BOOLEAN_KEYS) {
    if (updates[key] !== undefined && typeof updates[key] !== 'boolean') {
      throw invalidProfileField(`instance_options.${key}`, updates[key]);
    }
  }
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
  const normalized = normalizeConnectionValues(connectionValues);
  return autoReconnect === undefined
    ? normalized
    : { ...normalized, auto_reconnect: autoReconnect };
}

function toInstanceOptionsView(profile: MaaProfileDocument): MaaProfileInstanceOptions {
  const section = profile.instance_options;
  if (!isRecord(section)) return {};
  return normalizeInstanceOptions(section) as MaaProfileInstanceOptions;
}

/** 合并 `[instance_options]`：未知字段与现有已知字段都保留，只覆盖请求里的字段。 */
export function mergeMaaProfileInstanceOptions(
  profileDocument: unknown = {},
  updates: unknown = {}
): MaaProfileDocument {
  if (!isRecord(profileDocument)) {
    throw new TypeError('MAA profile 文档格式不合法');
  }
  if (!isRecord(updates)) {
    throw new TypeError('instance_options 配置格式不合法');
  }

  const existing = profileDocument.instance_options;
  if (existing != null && !isRecord(existing)) {
    throw new TypeError('现有 instance_options section 格式不合法');
  }

  const merged = {
    ...(isRecord(existing) ? existing : {}),
    ...normalizeInstanceOptions(updates)
  };
  if (Object.keys(merged).length === 0) return profileDocument;
  return { ...profileDocument, instance_options: merged };
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

/**
 * 读取 profile 的连接与实例选项视图。文件缺失或不可读时返回环境默认连接与
 * 空实例选项；已知字段归一别名，未知字段原样保留。
 */
export async function getProfile(profileName: unknown = 'default'): Promise<MaaProfileView> {
  const normalizedProfileName = validateMaaProfileName(profileName);
  try {
    const configPath = await getConfigPath(normalizedProfileName);
    const content = await readFile(configPath, 'utf-8');
    const profile = parseMaaProfile(content);
    return {
      connection: toConnectionView(profile),
      instance_options: toInstanceOptionsView(profile)
    };
  } catch {
    logger.debug('配置文件不存在，返回环境默认配置');
    return {
      connection: {
        adb_path: DEFAULT_ADB_PATH,
        address: DEFAULT_ADB_ADDRESS,
        config: 'CompatMac',
      },
      instance_options: {}
    };
  }
}

/** 兼容入口：只读取 connection 视图，供执行与预览侧解析连接参数。 */
export async function getConfig(profileName: unknown = 'default'): Promise<MaaProfileConnection> {
  return (await getProfile(profileName)).connection;
}

interface MaaProfileSaveSections {
  connection: unknown;
  instanceOptions: unknown;
}

/**
 * 兼容旧请求体：显式 `connection` 键优先；只带 `instance_options` 时不再把整份
 * 请求体当成 connection；两个键都缺失时沿用旧行为按 connection 处理。
 */
function readProfileSaveSections(body: Record<string, unknown>): MaaProfileSaveSections {
  const hasConnection = Object.prototype.hasOwnProperty.call(body, 'connection');
  const hasInstanceOptions = Object.prototype.hasOwnProperty.call(body, 'instance_options');
  return {
    connection: hasConnection ? body.connection : hasInstanceOptions ? undefined : body,
    instanceOptions: hasInstanceOptions ? body.instance_options : undefined
  };
}

/**
 * 保存 profile：connection 与 instance_options 各自按 section 合并，未知 section
 * 原样保留。写入前校验已知字段值域，非法值返回 400 且不落盘。
 */
export async function saveProfile(profileName: unknown = 'default', body: unknown): Promise<void> {
  try {
    const normalizedProfileName = validateMaaProfileName(profileName);
    if (!isRecord(body)) {
      throw new TypeError('connection 配置格式不合法');
    }

    const sections = readProfileSaveSections(body);
    if (sections.connection !== undefined) {
      if (!isRecord(sections.connection)) throw new TypeError('connection 配置格式不合法');
      validateConnectionUpdates(sections.connection);
    }
    if (sections.instanceOptions !== undefined) {
      if (!isRecord(sections.instanceOptions)) throw new TypeError('instance_options 配置格式不合法');
      validateInstanceOptionsUpdates(sections.instanceOptions);
    }

    const configPath = await getConfigPath(normalizedProfileName);

    // 同一 profile 的读取、合并与写入在同一排队单元内完成：并发保存不会互相覆盖未知 section，
    // 异名 profile 路径不同、互不阻塞。TOML 内容按文本原子替换；解析或写入失败时不写回，
    // 已有配置保持原样。
    await updateTextFile(configPath, currentContent => {
      let profile = currentContent === null ? {} : parseMaaProfile(currentContent);
      if (sections.connection !== undefined) {
        profile = mergeMaaProfileConnection(profile, { connection: sections.connection });
      }
      if (sections.instanceOptions !== undefined) {
        profile = mergeMaaProfileInstanceOptions(profile, sections.instanceOptions);
      }
      return stringifyToml(profile);
    });
    logger.debug('配置已保存', { configPath });
  } catch (error) {
    if (isAgentError(error)) throw error;
    throw new Error(`保存配置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 兼容入口：只写 connection 段，保留既有调用方的请求体语义。 */
export async function saveConfig(profileName: unknown = 'default', config: unknown): Promise<void> {
  return saveProfile(profileName, config);
}

