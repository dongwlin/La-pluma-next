/**
 * 自动任务域 API 端点
 * 当前活动信息与定时任务（调度）管理。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

/**
 * 获取当前活动信息
 */
export async function getActivity(clientType: string = 'Official'): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/activity?clientType=${clientType}`)
  return parseJsonResponse(response)
}

export async function runCurrentActivity(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/activity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  return parseJsonResponse(response)
}

/**
 * 设置定时任务
 */
export async function setupSchedule(
  scheduleId: string = 'default',
  times: string[],
  taskFlow: any[]
): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scheduleId, times, taskFlow }),
  })
  return parseJsonResponse(response)
}

/**
 * 停止定时任务
 */
export async function stopSchedule(scheduleId: string = 'default'): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/schedules/${scheduleId}`, {
    method: 'DELETE',
  })
  return parseJsonResponse(response)
}

/**
 * 获取定时任务执行状态
 */
export async function getScheduleExecutionStatus(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/schedules/execution`)
  return parseJsonResponse(response)
}

/**
 * 立即执行定时任务
 *
 * 默认保持旧同步行为；传 `waitForCompletion: false` 时服务端在流程获得执行权后
 * 返回 202，调用方改为观察 Run。`idempotencyKey` 由执行控制器为一次逻辑提交生成。
 */
export interface ScheduleExecutionOptions {
  waitForCompletion?: boolean
  idempotencyKey?: string
  signal?: AbortSignal
}

export async function executeScheduleNow(
  scheduleId: string = 'default',
  taskFlow: any[],
  options: ScheduleExecutionOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  const body: Record<string, unknown> = { taskFlow }
  if (options.waitForCompletion !== undefined) body.waitForCompletion = options.waitForCompletion

  const response = await fetchWithAuth(`${API_BASE_URL}/agent/schedules/${scheduleId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  })
  return parseJsonResponse(response)
}
