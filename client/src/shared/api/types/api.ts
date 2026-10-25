/**
 * API 响应类型定义
 */

/**
 * 只读请求失败的来源：
 * - `api`：服务端返回了 `success=false` 或非 2xx 响应；
 * - `contract`：响应不是可识别的信封，或领域载荷形状不合法；
 * - `transport`：请求没有拿到 HTTP 响应（断网、连接失败等）。
 * 取消读取不属于失败，保持抛出 `AbortError`。
 */
export type ApiFailureKind = 'api' | 'contract' | 'transport'

export interface ApiErrorPayload {
  code?: string
  message?: string
  details?: any
  retryable?: boolean
  kind?: ApiFailureKind
  status?: number
}

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
  message?: string
  meta?: {
    requestId?: string | null
    dryRun?: boolean
    [key: string]: any
  }
  errorInfo?: ApiErrorPayload
}
