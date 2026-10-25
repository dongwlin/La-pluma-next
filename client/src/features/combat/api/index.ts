/**
 * 战斗任务域 API 端点
 * 普通关卡作业与悖论模拟作业搜索，以及作业集 Run 的提交与继续。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'
import type { AgentRequestOptions } from '@/features/task-execution'

const isCopilotSearchPayload = (payload: unknown): boolean =>
  isRecord(payload) && Array.isArray(payload.copilots)

const isCopilotProxyPayload = (payload: unknown): boolean => isRecord(payload)

const isCopilotSetPlanPayload = (payload: unknown): boolean =>
  isRecord(payload) && Array.isArray(payload.items) && Array.isArray(payload.entries)

/**
 * 搜索普通关卡作业
 */
export async function searchCopilot(stageName: string, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/copilot/search?stage=${encodeURIComponent(stageName)}`, {
    signal,
    validate: isCopilotSearchPayload,
    invalidPayloadMessage: '作业搜索结果格式不正确',
  })
}

/**
 * 搜索悖论模拟作业
 */
export async function searchParadoxCopilot(operatorName: string, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/paradox/search?name=${encodeURIComponent(operatorName)}`, {
    signal,
    validate: isCopilotSearchPayload,
    invalidPayloadMessage: '悖论模拟搜索结果格式不正确',
  })
}

/**
 * 获取作业信息（通过后端代理，避免 CORS）
 * 响应为 PRTS 代理信封，具体内容由调用方按 status_code/data/content 解析。
 */
export async function getCopilotInfo(copilotId: string, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/copilots/${copilotId}`, {
    signal,
    validate: isCopilotProxyPayload,
    invalidPayloadMessage: '作业信息格式不正确',
  })
}

/**
 * 获取作业集信息（通过后端代理，避免 CORS）
 */
export async function getCopilotSet(copilotId: string, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/copilot-sets/${copilotId}`, {
    signal,
    validate: isCopilotProxyPayload,
    invalidPayloadMessage: '作业集信息格式不正确',
  })
}

export async function getCopilotSetPlan(
  copilotId: string,
  raid: 'normal' | 'raid' | 'both' = 'normal',
  signal?: AbortSignal,
): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/copilot-sets/${encodeURIComponent(copilotId)}/plan?raid=${raid}`, {
    signal,
    validate: isCopilotSetPlanPayload,
    invalidPayloadMessage: '作业集计划格式不正确',
  })
}

/**
 * 服务端作业集执行模式：`continuous` 由服务端持有整个队列，`manual` 每项之间
 * 释放设备并等待调用方继续。旧页面的 `app`/`cli` 都属于 `continuous`。
 */
export type CopilotSetRunMode = 'continuous' | 'manual'

export interface CopilotSetExecutePayload {
  raid: 'normal' | 'raid' | 'both'
  selectedIndexes: number[]
  options?: Record<string, unknown>
  mode?: CopilotSetRunMode
  /** 传 false 时在取得执行权后返回 202，由 Run 快照观察进度。 */
  waitForCompletion?: boolean
}

/**
 * 提交作业集执行。响应中的 `runId` 是本次执行的唯一身份。
 */
export async function executeCopilotSetPlan(
  copilotId: string,
  payload: CopilotSetExecutePayload,
  options: AgentRequestOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  const response = await fetchWithAuth(`${API_BASE_URL}/agent/copilot-sets/${encodeURIComponent(copilotId)}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
  return parseJsonResponse(response)
}

/**
 * 继续 manual 作业集的下一项。不创建新 run，也不使用独立幂等键；
 * 设备被占用时返回可重试的 409 `MAA_EXECUTION_BUSY`，run 保持等待态。
 */
export async function continueCopilotSet(
  runId: string,
  options: { waitForCompletion?: boolean } = {},
): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/continue-copilot-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, waitForCompletion: options.waitForCompletion ?? true })
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
