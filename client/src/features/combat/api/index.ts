/**
 * 战斗任务域 API 端点
 * 普通关卡作业与悖论模拟作业搜索。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

/**
 * 搜索普通关卡作业
 */
export async function searchCopilot(stageName: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot/search?stage=${encodeURIComponent(stageName)}`)
  return parseJsonResponse(response)
}

/**
 * 搜索悖论模拟作业
 */
export async function searchParadoxCopilot(operatorName: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/paradox/search?name=${encodeURIComponent(operatorName)}`)
  return parseJsonResponse(response)
}
