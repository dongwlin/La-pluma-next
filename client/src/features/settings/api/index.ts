/**
 * 设置域 API 端点
 * 版本、配置目录、MAA 配置、连接测试、设备发现与更新管理。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'
import type { AutoUpdateConfig } from '../types'

/**
 * 获取版本信息
 */
export async function getVersion(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/version`)
  return parseJsonResponse(response)
}

/**
 * 获取配置目录
 */
export async function getConfigDir(): Promise<ApiResponse<string>> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config-directory`)
  return parseJsonResponse(response)
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
export async function getConfig(profileName: string = 'default'): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/maa/${profileName}`)
  return parseJsonResponse(response)
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

export async function discoverDevices(adbPath: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/discover-devices?adbPath=${encodeURIComponent(adbPath)}`)
  return parseJsonResponse(response)
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
