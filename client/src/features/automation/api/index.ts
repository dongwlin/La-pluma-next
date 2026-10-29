/**
 * 自动任务域 API 端点
 * 当前活动信息与定时任务（调度）管理。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'

const isActivityPayload = (payload: unknown): boolean => isRecord(payload)

const isScheduleExecutionPayload = (payload: unknown): boolean => isRecord(payload)

/**
 * 获取当前活动信息
 *
 * `clientType` 省略时不拼查询串，由服务端按连接 profile 的 `client_type`
 * 解析；显式传入仍作为请求级覆盖。
 */
export async function getActivity(clientType?: string, signal?: AbortSignal): Promise<ApiResponse> {
  const query = clientType ? `?clientType=${encodeURIComponent(clientType)}` : ''
  return readApiResponse(`${API_BASE_URL}/agent/activity${query}`, {
    signal,
    validate: isActivityPayload,
    invalidPayloadMessage: '活动信息格式不正确',
  })
}

export interface ActivityRunOptions {
  idempotencyKey?: string
  signal?: AbortSignal
}

/**
 * 执行当前活动作业。
 *
 * 该端点始终保持同步：服务端先做活动预检（导航链、活动作业候选与偏好），
 * 预检不通过时直接返回 `executed=false` 与原因。`waitForCompletion` 不适用；
 * 调用方在响应中拿到 `runId` 后交给执行控制器保存身份。
 */
export async function runCurrentActivity(options: ActivityRunOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  const response = await fetchWithAuth(`${API_BASE_URL}/agent/activity/run`, {
    method: 'POST',
    headers,
    signal: options.signal,
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
export async function getScheduleExecutionStatus(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/schedules/execution`, {
    signal,
    validate: isScheduleExecutionPayload,
    invalidPayloadMessage: '定时任务执行状态格式不正确',
  })
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
