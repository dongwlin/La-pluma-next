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

/**
 * MAA profile 的 connection 段允许缺省字段（MAA 会使用自身默认值），因此只
 * 校验出现字段的类型；缺失的已知字段由设置域归一化模型补齐，未知字段保留。
 */
const isConfigPayload = (payload: unknown): boolean =>
  isRecord(payload)
  && (payload.adb_path === undefined || typeof payload.adb_path === 'string')
  && (payload.address === undefined || typeof payload.address === 'string')
  && (payload.config === undefined || typeof payload.config === 'string')
  && (payload.auto_reconnect === undefined || typeof payload.auto_reconnect === 'boolean')

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

export async function saveConfig(profileName: string = 'default', config: any): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/maa/${profileName}`, {
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
