/**
 * 自动任务域只读资源 Query 定义
 *
 * 当前活动与定时执行状态供总览完整快照读取；读取失败转为 Query 错误，
 * 取消保持 `AbortError`。总览协调器会以 `staleTime: 0` 读取，保证完整快照
 * 不混入 30s 内的旧活动/执行状态。
 */

import { queryOptions } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import { getActivity, getScheduleExecutionStatus } from '../api'
import { automationKeys } from './queryKeys'

export type AutomationActivityPayload = Record<string, unknown>
export type AutomationScheduleExecutionPayload = Record<string, unknown>

export const activityQueryOptions = (clientType = 'Official') => queryOptions({
  queryKey: automationKeys.query('activity', clientType),
  queryFn: async ({ signal }): Promise<AutomationActivityPayload> => (
    unwrapApiResponse<AutomationActivityPayload>(await getActivity(clientType, signal))
  ),
})

export const scheduleExecutionQueryOptions = () => queryOptions({
  queryKey: automationKeys.query('schedule-execution'),
  queryFn: async ({ signal }): Promise<AutomationScheduleExecutionPayload> => (
    unwrapApiResponse<AutomationScheduleExecutionPayload>(await getScheduleExecutionStatus(signal))
  ),
})
