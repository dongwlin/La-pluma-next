import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'
import type { AutoUpdateConfig } from '../types'

const isVersionPayload = (payload: unknown): boolean =>
  isRecord(payload)
  && typeof payload.cli === 'string'
  && typeof payload.core === 'string'
  && typeof payload.raw === 'string'

const isConfigDirectoryPayload = (payload: unknown): boolean =>
  typeof payload === 'string'
    ? payload.trim().length > 0
    : isRecord(payload) && typeof payload.path === 'string' && payload.path.trim().length > 0

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

const isConnectionSection = (value: unknown): boolean =>
  isRecord(value)
  && isOptionalString(value.adb_path)
  && isOptionalString(value.address)
  && isOptionalString(value.config)
  && (value.auto_reconnect === undefined || typeof value.auto_reconnect === 'boolean')

/**
 * MAA profile 载荷允许缺省字段（MAA 会使用自身默认值），因此只校验出现字段的
 * 类型；缺失的已知字段由设置域归一化模型补齐，未知字段保留。兼容旧版直接返回
 * connection 段的扁平形状。
 */
const isConfigPayload = (payload: unknown): boolean => {
  if (!isRecord(payload)) return false
  if (payload.connection === undefined && payload.instance_options === undefined) {
    return isConnectionSection(payload)
  }
  return isConnectionSection(payload.connection)
    && (payload.instance_options === undefined || isRecord(payload.instance_options))
}

const isResourceSourcePayload = (payload: unknown): boolean =>
  isRecord(payload)
  && typeof payload.autoUpdate === 'boolean'
  && typeof payload.warnOnUpdateFailure === 'boolean'
  && (payload.source === 'git' || payload.source === 'mirrorchyan')
  && isRecord(payload.git)
  && isRecord(payload.mirrorchyan)

const isDeviceDiscoveryPayload = (payload: unknown): boolean => isRecord(payload)

export async function getVersion(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/version`, {
    signal,
    validate: isVersionPayload,
    invalidPayloadMessage: '版本信息格式不正确',
  })
}

/**
 * 配置目录响应：服务端当前返回 `{ path }`，同时保留旧的纯字符串形状。
 * 归一化（取 `path`）属于设置域模型，API 层只负责类型与载荷校验。
 */
export type ConfigDirectoryValue = string | { path: string }

export async function getConfigDir(signal?: AbortSignal): Promise<ApiResponse<ConfigDirectoryValue>> {
  return readApiResponse<ConfigDirectoryValue>(`${API_BASE_URL}/agent/config-directory`, {
    signal,
    validate: isConfigDirectoryPayload,
    invalidPayloadMessage: '配置目录格式不正确',
  })
}

export async function openConfigDir(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/open-config-directory`, { method: 'POST' })
  return parseJsonResponse(response)
}

export async function getConfig(profileName: string = 'default', signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/config/maa/${profileName}`, {
    signal,
    validate: isConfigPayload,
    invalidPayloadMessage: '连接配置格式不正确',
  })
}

export async function saveConfig(
  profileName: string = 'default',
  config: Record<string, unknown>,
): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/maa/${profileName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  return parseJsonResponse(response)
}

export async function getResourceSource(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/config/resource-source`, {
    signal,
    validate: isResourceSourcePayload,
    invalidPayloadMessage: '资源源配置格式不正确',
  })
}

export async function saveResourceSource(config: Record<string, unknown>): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/resource-source`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  return parseJsonResponse(response)
}

export async function testConnection(adbPath?: string, address?: string, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/test-connection`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...(adbPath ? { adbPath } : {}), ...(address ? { address } : {}) }),
  })
  return parseJsonResponse(response)
}

export async function discoverDevices(adbPath: string, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/actions/discover-devices?adbPath=${encodeURIComponent(adbPath)}`, {
    signal,
    validate: isDeviceDiscoveryPayload,
    invalidPayloadMessage: '设备发现结果格式不正确',
  })
}

/**
 * 更新动作统一提交为服务端 Run：`waitForCompletion=false` 在取得执行权后返回
 * runId，调用方按 runId 观察终态或停止；请求体只带该端点自己的领域参数。
 */
async function submitUpdateRun(path: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, waitForCompletion: false }),
  })
  return parseJsonResponse(response)
}

export async function updateMaaCore(version?: string): Promise<ApiResponse> {
  return submitUpdateRun('/actions/update-core', version ? { version } : {})
}

export async function updateMaaCli(channel?: string): Promise<ApiResponse> {
  return submitUpdateRun('/actions/update-cli', channel ? { channel } : {})
}

export async function saveUpdateChannel(
  scope: 'core' | 'cli',
  channel: string,
): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/update-channel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scope, channel }),
  })
  return parseJsonResponse(response)
}

export async function hotUpdateResources(): Promise<ApiResponse> {
  return submitUpdateRun('/actions/hot-update-resources')
}

export async function setupAutoUpdate(config: AutoUpdateConfig): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/configure-auto-update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  return parseJsonResponse(response)
}
