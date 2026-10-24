/**
 * API 传输层底座
 * 同源地址探测、鉴权头合并与响应解析；不承载任何业务端点。
 */

import type { ApiResponse } from './types/api'

export { parseJsonResponse } from './apiResponse'

/**
 * 自动检测 API 地址
 * 始终使用当前页面同源地址。
 * 开发环境由 Vite proxy 转发 /api，生产环境由 Express 同源服务前端和 API。
 */
const getApiBaseUrl = (): string => {
  return `${window.location.origin}/api`
}

export const API_BASE_URL = getApiBaseUrl()

const getStoredToken = (): string => {
  const rawToken = localStorage.getItem('laPlumaToken') || ''
  const token = rawToken.replace(/^Bearer\s+/i, '').trim()

  // Headers.set() throws "The string did not match the expected pattern" when
  // the value contains CR/LF or other control characters. Treat malformed
  // stored tokens as absent so API calls can return a normal 401 instead of
  // crashing the UI action.
  return /[\u0000-\u001f\u007f]/.test(token) ? '' : token
}

const getAuthHeaders = (): Record<string, string> => {
  const token = getStoredToken()
  return token ? { Authorization: `Bearer ${token}`, 'X-La-Pluma-Token': token } : {}
}

export const fetchWithAuth = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers || {})
  Object.entries(getAuthHeaders()).forEach(([key, value]) => headers.set(key, value))

  try {
    return await fetch(input, { ...init, headers })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('当前网络已断开，请恢复连接后重试')
    }
    throw new Error('无法连接后端服务，请确认服务已启动')
  }
}

/**
 * 从 API 响应信封中提取可读错误信息
 */
export function getErrorMessage(result?: Partial<ApiResponse> | null): string {
  return result?.message || result?.errorInfo?.message || result?.error || '未知错误'
}
