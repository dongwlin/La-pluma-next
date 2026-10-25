/**
 * 设置域 API 端点
 * 版本、配置目录、MAA 配置、连接测试、设备发现与更新管理。
 */

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

const isConfigPayload = (payload: unknown): boolean => isRecord(payload)

const isDeviceDiscoveryPayload = (payload: unknown): boolean => isRecord(payload)

/**
 * 获取版本信息
 */
export async function getVersion(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/version`, {
    signal,
    validate: isVersionPayload,
    invalidPayloadMessage: '版本信息格式不正确',
  })
}

/**
 * 获取配置目录
 */
export async function getConfigDir(signal?: AbortSignal): Promise<ApiResponse<string>> {
  return readApiResponse<string>(`${API_BASE_URL}/agent/config-directory`, {
    signal,
    validate: isConfigDirectoryPayload,
    invalidPayloadMessage: '配置目录格式不正确',
  })
}

/**
 * 在本机文件管理器中打开配置目录
 */
export async function openConfigDir(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/open-config-directory`, { method: 'POST' })
  return parseJsonResponse(response)
}

/**
 * 获取配置
 */
export async function getConfig(profileName: string = 'default', signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/config/maa/${profileName}`, {
    signal,
    validate: isConfigPayload,
    invalidPayloadMessage: '连接配置格式不正确',
  })
}

/**
 * 保存配置
 */
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

/**
 * 测试 ADB 连接
 */
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
 * 更新 MaaCore
 */
export async function updateMaaCore(version?: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/update-core`, {
    method: 'POST',
    headers: version ? {
      'Content-Type': 'application/json',
    } : undefined,
    body: version ? JSON.stringify({ version }) : undefined,
  })
  return parseJsonResponse(response)
}

/**
 * 更新 MAA CLI
 */
export async function updateMaaCli(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/update-cli`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

/**
 * 热更新资源文件
 */
export async function hotUpdateResources(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/hot-update-resources`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

/**
 * 设置自动更新
 */
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
