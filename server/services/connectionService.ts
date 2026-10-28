/**
 * 连接 profile 解析与显式覆盖
 *
 * - profile 名称先经 `maaConfigService` 的同一白名单校验，拒绝路径穿越；
 *   不合法时抛出既有 `AGENT_VALIDATION_PROFILE_ID_INVALID`（400、不重试）。
 * - profile 配置来自 TOML 或 HTTP 请求体，按 `unknown` 收窄：`snake_case`
 *   优先、`camelCase` 兼容别名其次，只有非空字符串才作为连接值，其余回退
 *   到连接默认值适配（`config/connectionDefaults.ts`）。
 * - 显式覆盖只在调用方声明 `allowOverrides` 时生效，空白值不覆盖已保存配置。
 *
 * 执行、预览、定时与维护入口共用本模块，不各自拼装连接字段。
 */

import { getConfig, validateMaaProfileName } from './maaConfigService.ts';
import type { MaaProfileConnection } from './maaConfigService.ts';
import { agentError } from '../utils/apiHelper.ts';
import {
  DEFAULT_ADB_ADDRESS,
  DEFAULT_ADB_PATH,
  DEFAULT_CLIENT_TYPE
} from '../config/connectionDefaults.ts';

const DEFAULT_CONNECTION_PROFILE = 'default';

/** 解析后的连接视图；执行与预览只依赖这三个连接字段。 */
export interface ConnectionProfile {
  profileId: string;
  adbPath: string;
  address: string;
  clientType: string;
}

/** profile 配置读取端口；缺省读取 MAA profile（`maaConfigService.getConfig`）。 */
export type ConnectionConfigReader = (profileId: string) => Promise<MaaProfileConnection>;

export interface ResolveConnectionOptions {
  readConfig?: ConnectionConfigReader;
}

/** profile 解析端口；测试可注入固定 profile，避免启动 CLI。 */
export type ConnectionResolver = (profileId?: unknown) => Promise<ConnectionProfile>;

export interface ResolveConnectionInputOptions {
  /** 是否允许请求体/查询参数覆盖已保存的 profile 值 */
  allowOverrides?: boolean;
  resolver?: ConnectionResolver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按优先级读取 profile 中的字符串连接值；空字符串与其他类型都不算已配置。 */
function readProfileValue(config: MaaProfileConnection, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** 请求覆盖值：只有非空字符串生效，并去掉首尾空白。 */
function readOverride(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 解析指定 profile 的连接参数；profile 不存在或读取失败时由
 * `maaConfigService` 返回环境默认配置，这里再补齐连接默认值。
 */
export async function resolveConnection(
  profileId: unknown = DEFAULT_CONNECTION_PROFILE,
  options: ResolveConnectionOptions = {}
): Promise<ConnectionProfile> {
  const normalizedProfileId = String(profileId ?? DEFAULT_CONNECTION_PROFILE).trim();
  try {
    validateMaaProfileName(normalizedProfileId);
  } catch {
    throw agentError('AGENT_VALIDATION_PROFILE_ID_INVALID', '连接配置名称不合法', {
      statusCode: 400,
      details: { profileId },
      retryable: false
    });
  }

  const readConfig = options.readConfig ?? getConfig;
  const config = await readConfig(normalizedProfileId);
  return {
    profileId: normalizedProfileId,
    adbPath: readProfileValue(config, ['adb_path', 'adbPath']) ?? DEFAULT_ADB_PATH,
    address: readProfileValue(config, ['address']) ?? DEFAULT_ADB_ADDRESS,
    clientType: readProfileValue(config, ['client_type', 'clientType']) ?? DEFAULT_CLIENT_TYPE
  };
}

/**
 * 先解析 profile，再在允许时应用请求级显式覆盖；空白或缺失的覆盖值保留
 * profile 值。`input` 来自查询参数与请求体合并，按 `unknown` 收窄。
 */
export async function resolveConnectionInput(
  input: unknown = {},
  options: ResolveConnectionInputOptions = {}
): Promise<ConnectionProfile> {
  const { allowOverrides = false, resolver = resolveConnection } = options;
  const values = isRecord(input) ? input : {};
  const base = await resolver(values.profileId);
  if (!allowOverrides) return base;

  return {
    ...base,
    adbPath: readOverride(values.adbPath) ?? base.adbPath,
    address: readOverride(values.address) ?? base.address,
    clientType: readOverride(values.clientType) ?? base.clientType
  };
}
