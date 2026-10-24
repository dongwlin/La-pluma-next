/**
 * 日志域 API 端点
 * 实时日志、日志文件列表与读取、手动清理。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

/**
 * 获取实时日志
 */
export async function getRealtimeLogs(lines: number = 100, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/recent?lines=${lines}`, { signal })
  return parseJsonResponse(response)
}

/**
 * 清空实时日志
 */
export async function clearRealtimeLogs(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/recent/clear`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

/**
 * 获取日志文件列表
 */
export async function getLogFiles(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/files`)
  return parseJsonResponse(response)
}

/**
 * 读取日志文件内容
 */
export async function readLogFile(filePath: string, lines: number = 1000): Promise<ApiResponse> {
  const encodedPath = encodeURIComponent(filePath)
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/files/${encodedPath}?lines=${lines}`)
  return parseJsonResponse(response)
}

/**
 * 手动清理日志文件
 */
export async function cleanupLogs(maxSizeMB: number = 10): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/cleanup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ maxSizeMB }),
  })
  return parseJsonResponse(response)
}
