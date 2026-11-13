import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'
import type { AgentRun, RunSnapshot, StopMode, StopRunResult } from '../types'

export interface StopRunOptions {
  /** 缺省时保持旧请求形态：立即停止，且不发送请求体。 */
  mode?: StopMode
}

export async function getRunSnapshot(signal?: AbortSignal): Promise<ApiResponse<RunSnapshot>> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/runs/current`, { signal })
  return parseJsonResponse(response)
}

/**
 * 按 runId 读取单次执行，终态记录在保留期内仍可读取。
 */
export async function getRun(runId: string, signal?: AbortSignal): Promise<ApiResponse<AgentRun>> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/runs/${encodeURIComponent(runId)}`, { signal })
  return parseJsonResponse(response)
}

/**
 * 目标停止：只请求终止指定 run，不会误伤随后启动的其它执行。
 * 停止意图可以安全重试；调用方仍需轮询到终态。
 */
export async function stopRun(
  runId: string,
  options: StopRunOptions = {},
): Promise<ApiResponse<StopRunResult>> {
  const url = new URL(`${API_BASE_URL}/agent/actions/stop`)
  url.searchParams.set('runId', runId)
  const mode = options.mode
  const init: RequestInit = mode
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }
    : { method: 'POST' }
  const response = await fetchWithAuth(url, init)
  return parseJsonResponse(response)
}
