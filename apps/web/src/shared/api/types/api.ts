/**
 * 只读请求失败的来源：`api`（`success=false` 或非 2xx）、`contract`（信封或领域载荷不合法）、
 * `transport`（没有拿到 HTTP 响应）。取消读取不属于失败，保持抛出 `AbortError`。
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
