/**
 * 自动任务域只读资源 Query 定义
 *
 * 当前活动与定时执行状态供总览完整快照读取；读取失败转为 Query 错误，
 * 取消保持 `AbortError`。总览协调器会以 `staleTime: 0` 读取，保证完整快照
 * 不混入 30s 内的旧活动/执行状态。
 *
 * 活动查询不硬编码服务区：不传 `clientType` 时服务端按连接 profile 的
 * `client_type` 解析，Query key 使用 `profile` 哨兵。
 */

import { queryOptions } from '@tanstack/react-query'
import { ApiRequestError, unwrapApiResponse } from '@/shared/api'
import { getActivity, getScheduleExecutionStatus } from '../api'
import { normalizeActivityPayload, type AutomationActivityPayload } from './activity'
import { automationKeys } from './queryKeys'

export type AutomationScheduleExecutionPayload = Record<string, unknown>

const invalidActivityPayloadError = () => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message: '活动信息格式不正确',
  retryable: false,
})

export const activityQueryOptions = (clientType?: string) => queryOptions({
  queryKey: automationKeys.query('activity', clientType ?? 'profile'),
  queryFn: async ({ signal }): Promise<AutomationActivityPayload> => {
    const payload = unwrapApiResponse<unknown>(await getActivity(clientType, signal))
    const activity = normalizeActivityPayload(payload)
    if (!activity) throw invalidActivityPayloadError()
    return activity
  },
})

export const scheduleExecutionQueryOptions = () => queryOptions({
  queryKey: automationKeys.query('schedule-execution'),
  queryFn: async ({ signal }): Promise<AutomationScheduleExecutionPayload> => (
    unwrapApiResponse<AutomationScheduleExecutionPayload>(await getScheduleExecutionStatus(signal))
  ),
})
