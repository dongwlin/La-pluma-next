/**
 * API 传输层底座
 * 同源地址探测、鉴权头合并与响应解析；不承载任何业务端点。
 */

import { isAbortError } from './abort'
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

export const AUTH_TOKEN_STORAGE_KEY = 'laPlumaToken'

const normalizeToken = (value: string | null | undefined): string => {
  const token = (value ?? '').replace(/^Bearer\s+/i, '').trim()

  // Headers.set() throws "The string did not match the expected pattern" when
  // the value contains CR/LF or other control characters. Treat malformed
  // stored tokens as absent so API calls can return a normal 401 instead of
  // crashing the UI action.
  return /[\u0000-\u001f\u007f]/.test(token) ? '' : token
}

/**
 * 模块级 token 缓存。`localStorage.getItem` 是同步阻塞调用，不能在每个请求上
 * 重复执行；登录/登出/显式设置 token 的入口必须调用 `setAuthToken`。
 * `null` 表示尚未从存储初始化。
 */
let cachedToken: string | null = null

const readStoredToken = (): string => {
  try {
    return normalizeToken(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY))
  } catch {
    return ''
  }
}

const getAuthToken = (): string => {
  if (cachedToken === null) cachedToken = readStoredToken()
  return cachedToken
}

/** 登录、登出或设置 token 后显式更新缓存与持久化，避免下一次请求读到旧值。 */
export function setAuthToken(token: string | null): void {
  const normalized = normalizeToken(token)
  cachedToken = normalized
  try {
    if (normalized) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, normalized)
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    // 隐私模式下存储可能不可用；本次会话仍使用内存中的令牌。
  }
}

export function clearAuthToken(): void {
  // 回到“尚未初始化”状态：下一次请求重新读取存储，避免登出后仍使用内存令牌。
  cachedToken = null
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    // 存储不可用时只需保证内存缓存已清空。
  }
}

// 其它标签页登录/登出时同步缓存；同标签页必须走 `setAuthToken`。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === AUTH_TOKEN_STORAGE_KEY) cachedToken = normalizeToken(event.newValue)
  })
}

const getAuthHeaders = (): Record<string, string> => {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}`, 'X-La-Pluma-Token': token } : {}
}

export const fetchWithAuth = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers || {})
  Object.entries(getAuthHeaders()).forEach(([key, value]) => headers.set(key, value))

  try {
    return await fetch(input, { ...init, headers })
  } catch (error) {
    if (isAbortError(error)) throw error
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
