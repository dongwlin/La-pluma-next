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

/**
 * 获取作业信息（通过后端代理，避免 CORS）
 * 响应为 PRTS 代理信封，具体内容由调用方按 status_code/data/content 解析。
 */
export async function getCopilotInfo(copilotId: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilots/${copilotId}`)
  return parseJsonResponse(response)
}

/**
 * 获取作业集信息（通过后端代理，避免 CORS）
 */
export async function getCopilotSet(copilotId: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot-sets/${copilotId}`)
  return parseJsonResponse(response)
}

export async function getCopilotSetPlan(copilotId: string, raid: 'normal' | 'raid' | 'both' = 'normal'): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot-sets/${encodeURIComponent(copilotId)}/plan?raid=${raid}`)
  return parseJsonResponse(response)
}

export async function executeCopilotSetPlan(copilotId: string, payload: {
  raid: 'normal' | 'raid' | 'both'
  selectedIndexes: number[]
  options?: Record<string, unknown>
}): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot-sets/${encodeURIComponent(copilotId)}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return parseJsonResponse(response)
}

export async function resetCopilotSetProgress(copilotId: string): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot-sets/${encodeURIComponent(copilotId)}/reset-progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  return parseJsonResponse(response)
}
