/**
 * Run 查询与目标停止端点
 * `runs/current` 是应用级运行快照的唯一读取入口；按 runId 查询用于保留调用方自己的身份。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'
import type { AgentRun, RunSnapshot, StopRunResult } from '../types'

/**
 * 读取运行快照：当前活动 run、全部活动意图、最近终态与设备占用。
 */
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
export async function stopRun(runId: string): Promise<ApiResponse<StopRunResult>> {
  const url = new URL(`${API_BASE_URL}/agent/actions/stop`)
  url.searchParams.set('runId', runId)
  const response = await fetchWithAuth(url, { method: 'POST' })
  return parseJsonResponse(response)
}
