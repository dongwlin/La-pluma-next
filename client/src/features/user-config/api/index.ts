/**
 * 用户配置微域 API
 * 后端用户任务配置（automation-tasks、combat-tasks、roguelike-tasks、auto-update 等）的读写。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

/**
 * 保存用户配置到服务器
 */
export async function saveUserConfig(configType: string, data: any): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/user/${configType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  return parseJsonResponse(response)
}

/**
 * 从服务器读取用户配置
 */
export async function loadUserConfig(configType: string, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/user/${configType}`, { signal })
  return parseJsonResponse(response)
}
