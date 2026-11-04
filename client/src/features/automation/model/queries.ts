import { queryOptions } from '@tanstack/react-query'
import { ApiRequestError, unwrapApiResponse } from '@/shared/api'
import { getActivity, getNotificationConfig, getScheduleExecutionStatus } from '../api'
import { normalizeActivityPayload, type AutomationActivityPayload } from './activity'
import { normalizeNotificationConfig, type NotificationConfig } from './notificationConfig'
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

const invalidNotificationConfigError = () => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message: '通知配置格式不正确',
  retryable: false,
})

/**
 * 通知配置：自动化域唯一的只读缓存。保存成功后调用方用
 * `setQueryData` 写回同一 key，不保留模块级永久缓存。
 */
export const notificationConfigQueryOptions = () => queryOptions({
  queryKey: automationKeys.resource('notification-config'),
  queryFn: async ({ signal }): Promise<NotificationConfig> => {
    const payload = unwrapApiResponse<unknown>(await getNotificationConfig(signal))
    const config = normalizeNotificationConfig(payload)
    if (!config) throw invalidNotificationConfigError()
    return config
  },
  retry: false,
})
