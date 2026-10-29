/**
 * 自动任务域的活动 DTO
 *
 * 服务端 `/agent/activity` 返回带状态的快照：空活动、来源失败与首轮失败
 * 各有独立状态，地区、来源时间与失败原因随载荷一起返回。本模块只做形状
 * 收窄，不推断“有没有活动”，也不把缺失字段补成看似成功的结果。
 */

import { isRecord } from '@/shared/api'

export type ActivityStatus = 'active' | 'none' | 'unavailable' | 'stale'

export interface ActivityFailure {
  source: string
  message: string
}

export interface AutomationActivityCompletion {
  known?: boolean
  complete?: boolean
  completedStages?: string[]
  totalStages?: number
  source?: string
}

export interface AutomationActivityPayload {
  status: ActivityStatus
  clientType: string
  available: boolean
  message: string
  code: string | null
  name: string | null
  source: string | null
  startTime: number | null
  endTime: number | null
  stages: string[]
  lastSuccessAt: number | null
  dataUpdatedAt: number | null
  failure: ActivityFailure | null
  completion?: AutomationActivityCompletion
}

const MAX_ACTIVITY_STAGES = 500

const ACTIVITY_STATUSES: readonly ActivityStatus[] = ['active', 'none', 'unavailable', 'stale']

const isActivityStatus = (value: unknown): value is ActivityStatus => (
  typeof value === 'string' && (ACTIVITY_STATUSES as readonly string[]).includes(value)
)

const isTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
)

const isNullableTimestamp = (value: unknown) => value === null || isTimestamp(value)
const isNullableString = (value: unknown) => value === null || typeof value === 'string'

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value)
  && value.length <= MAX_ACTIVITY_STAGES
  && value.every(item => typeof item === 'string')
)

const isActivityFailure = (value: unknown): value is ActivityFailure => (
  isRecord(value)
  && typeof value.source === 'string'
  && value.source.length > 0
  && typeof value.message === 'string'
)

const isActivityCompletion = (value: unknown): value is AutomationActivityCompletion => (
  isRecord(value)
  && (value.known === undefined || typeof value.known === 'boolean')
  && (value.complete === undefined || typeof value.complete === 'boolean')
  && (value.completedStages === undefined || isStringArray(value.completedStages))
  && (value.totalStages === undefined || isTimestamp(value.totalStages))
  && (value.source === undefined || typeof value.source === 'string')
)

const normalizeCompletion = (value: unknown): AutomationActivityCompletion | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isActivityCompletion(value)) return undefined
  return {
    known: value.known,
    complete: value.complete,
    completedStages: value.completedStages ? [...value.completedStages] : undefined,
    totalStages: value.totalStages,
    source: value.source,
  }
}

/**
 * 校验并归一 `/agent/activity` 载荷；任何必填字段缺失或类型不符返回 `null`。
 * 可空字段保留 `null` 的语义，不从名称/代号猜测状态。
 */
export function normalizeActivityPayload(value: unknown): AutomationActivityPayload | null {
  if (!isRecord(value)) return null
  if (!isActivityStatus(value.status)) return null
  if (typeof value.clientType !== 'string' || !value.clientType) return null
  if (typeof value.available !== 'boolean') return null
  if (typeof value.message !== 'string') return null
  if (!isNullableString(value.code)) return null
  if (!isNullableString(value.name)) return null
  if (!isNullableString(value.source)) return null
  if (!isNullableTimestamp(value.startTime)) return null
  if (!isNullableTimestamp(value.endTime)) return null
  if (!isStringArray(value.stages)) return null
  if (!isNullableTimestamp(value.lastSuccessAt)) return null
  if (!isNullableTimestamp(value.dataUpdatedAt)) return null
  if (value.completion !== undefined && value.completion !== null && !isActivityCompletion(value.completion)) {
    return null
  }
  let failure: ActivityFailure | null = null
  if (value.failure !== null) {
    if (!isActivityFailure(value.failure)) return null
    failure = { source: value.failure.source, message: value.failure.message }
  }

  return {
    status: value.status,
    clientType: value.clientType,
    available: value.available,
    message: value.message,
    code: value.code,
    name: value.name,
    source: value.source,
    startTime: value.startTime,
    endTime: value.endTime,
    stages: [...value.stages],
    lastSuccessAt: value.lastSuccessAt,
    dataUpdatedAt: value.dataUpdatedAt,
    failure,
    completion: normalizeCompletion(value.completion),
  }
}
