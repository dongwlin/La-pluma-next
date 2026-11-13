import { getConfig, validateMaaProfileName } from './maaConfigService.ts';
import type { MaaProfileConnection } from './maaConfigService.ts';
import { agentError } from '../utils/apiHelper.ts';
import {
  DEFAULT_ADB_ADDRESS,
  DEFAULT_ADB_PATH,
  DEFAULT_CLIENT_TYPE
} from '../config/connectionDefaults.ts';

const DEFAULT_CONNECTION_PROFILE = 'default';

export interface ConnectionProfile {
  profileId: string;
  adbPath: string;
  address: string;
  clientType: string;
}

export type ConnectionConfigReader = (profileId: string) => Promise<MaaProfileConnection>;

export interface ResolveConnectionOptions {
  readConfig?: ConnectionConfigReader;
}

export type ConnectionResolver = (profileId?: unknown) => Promise<ConnectionProfile>;

export interface ResolveConnectionInputOptions {
  allowOverrides?: boolean;
  resolver?: ConnectionResolver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProfileValue(config: MaaProfileConnection, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

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
