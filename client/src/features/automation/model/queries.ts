import { queryOptions } from '@tanstack/react-query'
import { ApiRequestError, isRecord, unwrapApiResponse } from '@/shared/api'
import {
  getActivity,
  getNotificationConfig,
  getScheduleExecutionStatus,
  listInfrastSchedules,
  readInfrastSchedule,
} from '../api'
import { normalizeActivityPayload, type AutomationActivityPayload } from './activity'
import {
  parseInfrastScheduleDocument,
  type InfrastScheduleDocument,
  type InfrastScheduleListPayload,
} from './infrastSchedule'
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

const invalidInfrastScheduleListError = () => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message: '排班文件列表格式不正确',
  retryable: false,
})

const invalidInfrastScheduleError = (message = '排班文件格式不正确') => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message,
  retryable: false,
})

/** 自定义基建排班文件列表，供编辑器选择已有文件。 */
export const infrastScheduleListQueryOptions = () => queryOptions({
  queryKey: automationKeys.resource('infrast-schedule-list'),
  queryFn: async ({ signal }): Promise<InfrastScheduleListPayload> => {
    const payload = unwrapApiResponse<unknown>(await listInfrastSchedules(signal))
    if (!isRecord(payload) || typeof payload.directory !== 'string' || !Array.isArray(payload.schedules)) {
      throw invalidInfrastScheduleListError()
    }
    return {
      directory: payload.directory,
      schedules: payload.schedules.filter((item): item is InfrastScheduleListPayload['schedules'][number] => (
        isRecord(item)
        && typeof item.name === 'string'
        && (item.title === null || typeof item.title === 'string')
        && typeof item.planCount === 'number'
        && typeof item.valid === 'boolean'
        && (item.updatedAt === null || typeof item.updatedAt === 'string')
      )),
    }
  },
  retry: false,
})

export interface InfrastSchedulePayload {
  name: string
  document: InfrastScheduleDocument
}

/** 单个自定义基建排班文件；只在有文件名时读取。 */
export const infrastScheduleQueryOptions = (name: string) => queryOptions({
  queryKey: automationKeys.query('infrast-schedule', name),
  queryFn: async ({ signal }): Promise<InfrastSchedulePayload> => {
    const payload = unwrapApiResponse<unknown>(await readInfrastSchedule(name, signal))
    if (!isRecord(payload) || typeof payload.name !== 'string') throw invalidInfrastScheduleError()
    const parsed = parseInfrastScheduleDocument(payload.document)
    if (!parsed.ok) throw invalidInfrastScheduleError(parsed.message)
    return { name: payload.name, document: parsed.document }
  },
  enabled: name.trim().length > 0,
  retry: false,
})
