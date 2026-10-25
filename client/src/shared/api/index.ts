/**
 * Shared API 公开面
 * 只保留协议/传输层底座（API_BASE_URL、fetchWithAuth、parseJsonResponse、
 * getErrorMessage、只读请求与载荷校验）与共享响应类型；各业务端点由各自
 * feature 的 api/ 目录持有。
 */

export { API_BASE_URL, fetchWithAuth, getErrorMessage, parseJsonResponse } from './client'
export {
  ApiRequestError,
  apiFailureResponse,
  isAbortError,
  readApiData,
  readApiResponse,
  unwrapApiResponse,
} from './readApi'
export { isRecord } from './validation'
export type { ApiFailureKind, ApiReadOptions, ApiReadResult, ApiRequestErrorOptions } from './readApi'
export type { ApiErrorPayload, ApiResponse } from './types/api'
