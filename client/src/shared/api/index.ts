/**
 * Shared API 公开面
 * 只保留协议/传输层底座（API_BASE_URL、fetchWithAuth、parseJsonResponse）、
 * maaApi 客户端与共享响应类型；各业务端点由各自 feature 的 api/ 目录持有。
 */

export { API_BASE_URL, fetchWithAuth, maaApi, parseJsonResponse } from './api'
export type { WebrtcStatusData } from './api'
export type { ApiErrorPayload, ApiResponse } from './types/api'
