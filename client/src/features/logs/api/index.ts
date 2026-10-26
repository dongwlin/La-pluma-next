/**
 * 日志域 API 端点
 * 实时日志、日志文件列表与读取、手动清理。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'

const isRealtimeLogsPayload = (payload: unknown): boolean => Array.isArray(payload)

const isLogFilesPayload = (payload: unknown): boolean => Array.isArray(payload)

const isLogFilePayload = (payload: unknown): boolean =>
  isRecord(payload) && typeof payload.content === 'string'

/**
 * 获取实时日志
 */
export async function getRealtimeLogs(lines: number = 100, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/logs/recent?lines=${lines}`, {
    signal,
    validate: isRealtimeLogsPayload,
    invalidPayloadMessage: '实时日志格式不正确',
  })
}

/**
 * 清空实时日志
 *
 * `signal` 只结束本地等待；服务端已收到的清空动作不会被撤销。
 */
export async function clearRealtimeLogs(signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/recent/clear`, {
    method: 'POST',
    signal,
  })
  return parseJsonResponse(response)
}

/**
 * 获取日志文件列表
 */
export async function getLogFiles(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/logs/files`, {
    signal,
    validate: isLogFilesPayload,
    invalidPayloadMessage: '日志文件列表格式不正确',
  })
}

/**
 * 读取日志文件内容
 */
export async function readLogFile(
  filePath: string,
  lines: number = 1000,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const encodedPath = encodeURIComponent(filePath)
  return readApiResponse(`${API_BASE_URL}/agent/logs/files/${encodedPath}?lines=${lines}`, {
    signal,
    validate: isLogFilePayload,
    invalidPayloadMessage: '日志文件内容格式不正确',
  })
}

/**
 * 手动清理日志文件
 *
 * `signal` 只结束本地等待；服务端已收到的清理动作不会被撤销。
 */
export async function cleanupLogs(
  maxSizeMB: number = 10,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/logs/cleanup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ maxSizeMB }),
    signal,
  })
  return parseJsonResponse(response)
}
