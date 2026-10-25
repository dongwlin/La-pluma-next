/**
 * 只读资源请求底座
 *
 * 负责三件事：
 * 1. 把调用方的 `AbortSignal` 完整传到 `fetchWithAuth`，取消时保持 `AbortError`；
 * 2. 校验统一响应信封与领域载荷，`success=false`、坏 JSON、非信封和非预期载荷
 *    都成为明确失败，而不是被当成成功数据；
 * 3. 把失败归类为 `api` / `contract` / `transport`，供调用方或 Query 统一处理。
 *
 * 本模块不包含任何业务端点；端点函数在各自 `features/<domain>/api/` 中调用它。
 */

import { isAbortError } from './abort'
import { parseJsonResponse } from './apiResponse'
import { fetchWithAuth } from './client'
import type { ApiFailureKind, ApiResponse } from './types/api'

export type { ApiFailureKind } from './types/api'
export { isAbortError } from './abort'

export interface ApiRequestErrorOptions {
  kind: ApiFailureKind
  code: string
  message: string
  status?: number
  retryable?: boolean
  details?: unknown
}

/**
 * 只读请求的类型化失败。取消读取不会抛出本错误，而是保留 `AbortError`。
 */
export class ApiRequestError extends Error {
  readonly kind: ApiFailureKind
  readonly code: string
  readonly status?: number
  readonly retryable: boolean
  readonly details?: unknown

  constructor({ kind, code, message, status, retryable = false, details }: ApiRequestErrorOptions) {
    super(message)
    this.name = 'ApiRequestError'
    this.kind = kind
    this.code = code
    this.status = status
    this.retryable = retryable
    this.details = details
  }
}

/**
 * 取消与失败使用不同信号：传输层把 `AbortError` 原样抛出，
 * 页面卸载或切换资源时不应显示为请求失败。
 */
const createAbortError = (): DOMException => new DOMException('请求已取消', 'AbortError')

const createTransportError = (error: unknown): ApiRequestError =>
  new ApiRequestError({
    kind: 'transport',
    code: 'NETWORK_ERROR',
    message: error instanceof Error && error.message
      ? error.message
      : '无法连接后端服务，请确认服务已启动',
    retryable: true,
  })

export interface ApiReadOptions extends Omit<RequestInit, 'signal'> {
  /** 调用方取消读取；取消不产生 `ApiResponse` 失败。 */
  signal?: AbortSignal
  /** 领域载荷校验；返回 false 时成为 `INVALID_DOMAIN_PAYLOAD`。 */
  validate?: (payload: unknown) => boolean
  invalidPayloadMessage?: string
}

export interface ApiReadResult<T> {
  data: T
  message?: string
  meta?: ApiResponse['meta']
}

const resolveFailureMessage = (parsed: ApiResponse | undefined, status: number): string => {
  const message = parsed?.message || parsed?.errorInfo?.message || parsed?.error
  if (typeof message === 'string' && message.trim()) return message
  return status >= 500 ? '后端服务暂不可用，请确认服务已启动' : `请求失败（HTTP ${status}）`
}

/**
 * 读取一个 Agent API 资源，成功返回领域数据，失败抛出 `ApiRequestError`。
 * 这是 Query 等新消费者的入口；取消（`AbortError`）不会被包装。
 */
export async function readApiData<T = unknown>(
  input: RequestInfo | URL,
  options: ApiReadOptions = {},
): Promise<ApiReadResult<T>> {
  const { signal, validate, invalidPayloadMessage = '服务返回的数据格式不正确', ...init } = options

  if (signal?.aborted) throw createAbortError()

  let response: Response
  try {
    response = await fetchWithAuth(input, { ...init, signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw createTransportError(error)
  }

  if (signal?.aborted) throw createAbortError()

  let parsed: ApiResponse
  try {
    parsed = await parseJsonResponse<ApiResponse>(response)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw createTransportError(error)
  }

  if (signal?.aborted) throw createAbortError()

  if (!response.ok) {
    const serverCode = parsed?.success === false ? parsed.errorInfo?.code : undefined
    const code = serverCode && serverCode !== 'INVALID_API_RESPONSE' && serverCode !== 'EMPTY_API_RESPONSE'
      ? serverCode
      : `HTTP_${response.status}`
    throw new ApiRequestError({
      kind: 'api',
      code,
      message: resolveFailureMessage(parsed, response.status),
      status: response.status,
      retryable: parsed?.errorInfo?.retryable ?? response.status >= 500,
      details: parsed?.errorInfo?.details,
    })
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') {
    throw new ApiRequestError({
      kind: 'contract',
      code: 'INVALID_API_RESPONSE',
      message: '服务返回了无法识别的数据',
      status: response.status,
      retryable: false,
    })
  }

  if (!parsed.success) {
    const errorInfo = parsed.errorInfo
    const contractFailure = errorInfo?.code === 'INVALID_API_RESPONSE' || errorInfo?.code === 'EMPTY_API_RESPONSE'
    throw new ApiRequestError({
      kind: contractFailure ? 'contract' : 'api',
      code: errorInfo?.code || 'API_OPERATION_FAILED',
      message: resolveFailureMessage(parsed, response.status),
      status: response.status,
      retryable: errorInfo?.retryable ?? false,
      details: errorInfo?.details,
    })
  }

  let validPayload = true
  if (validate) {
    try {
      validPayload = validate(parsed.data)
    } catch {
      validPayload = false
    }
  }

  if (!validPayload) {
    throw new ApiRequestError({
      kind: 'contract',
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: invalidPayloadMessage,
      status: response.status,
      retryable: false,
    })
  }

  return { data: parsed.data as T, message: parsed.message, meta: parsed.meta }
}

/**
 * 把失败转换回旧消费者使用的 `ApiResponse` 失败信封。
 */
export function apiFailureResponse<T = unknown>(error: ApiRequestError): ApiResponse<T> {
  return {
    success: false,
    error: error.message,
    message: error.message,
    errorInfo: {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
      kind: error.kind,
      status: error.status,
    },
  }
}

/**
 * 旧消费者兼容入口：返回既有的 `ApiResponse` 形状，失败时带类型化 `errorInfo`。
 * 取消读取仍然抛出 `AbortError`，不会变成 `success=false`。
 */
export async function readApiResponse<T = unknown>(
  input: RequestInfo | URL,
  options: ApiReadOptions = {},
): Promise<ApiResponse<T>> {
  try {
    const { data, message, meta } = await readApiData<T>(input, options)
    return { success: true, data, message, meta }
  } catch (error) {
    if (isAbortError(error)) throw error
    return apiFailureResponse<T>(error instanceof ApiRequestError ? error : createTransportError(error))
  }
}

/**
 * 把 `ApiResponse` 失败还原成类型化错误，供后续 Query 迁移直接消费。
 */
export function unwrapApiResponse<T>(result: ApiResponse<T>): T {
  if (result.success) return result.data as T

  throw new ApiRequestError({
    kind: result.errorInfo?.kind ?? 'api',
    code: result.errorInfo?.code ?? 'API_OPERATION_FAILED',
    message: result.errorInfo?.message || result.message || result.error || '操作失败',
    status: result.errorInfo?.status,
    retryable: result.errorInfo?.retryable ?? false,
    details: result.errorInfo?.details,
  })
}
