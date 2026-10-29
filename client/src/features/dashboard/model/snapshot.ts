/**
 * 总览完整业务快照的纯归一模型
 *
 * 五路业务读取（activity、schedule execution、training queue、today drops、
 * open-today stages）只有全部通过形状校验时才归一为一份完整快照；任一路
 * 缺失或格式不符都返回 `null`，由调用方保留上一份完整快照。
 *
 * 本模块不发起请求、不读写 store，设备采样也不参与业务快照有效性。
 * 端点读取与协调提交见 `model/queries.ts` 与 `model/snapshotRefresher.ts`。
 */

import { isRecord } from '@/shared/api'
import {
  normalizeActivityPayload,
  type ActivityFailure,
  type ActivityStatus,
  type AutomationActivityCompletion,
} from '@/features/automation'
import { formatExecutionSummary, getExecutionLastTask } from '@/shared/utils/executionSummary'

export interface ActivitySummary {
  available: boolean
  status?: ActivityStatus
  clientType?: string
  message?: string
  code?: string
  name?: string
  source?: string
  startTime?: number
  endTime?: number
  stages?: string[]
  lastSuccessAt?: number
  dataUpdatedAt?: number
  failure?: ActivityFailure
  completion?: AutomationActivityCompletion
}

export interface ScheduleSummary {
  isRunning: boolean
  currentTask?: string
  message?: string
  lastTask?: string
  lastResult?: string
}

export interface TrainingSummary {
  count: number
  topNames: string[]
}

export interface DropSummary {
  count: number
  recent: Array<{
    stage: string
    items: string
  }>
}

export interface OpenStageSummary {
  open: Array<{ stage: string; name: string }>
  closed: Array<{ stage: string; name: string }>
}

/** 五路业务结果全部有效时才提交的完整快照。 */
export interface DashboardBusinessSnapshot {
  activitySummary: ActivitySummary
  scheduleSummary: ScheduleSummary
  trainingSummary: TrainingSummary
  dropSummary: DropSummary
  openStageSummary: OpenStageSummary
}

/** 协调器从各领域查询取得的原始载荷；形状在归一阶段统一裁决。 */
export interface DashboardSnapshotPayloads {
  activity: unknown
  scheduleExecution: unknown
  trainingQueue: unknown
  todayDrops: unknown
  openTodayStages: unknown
}

const MAX_STAGE_SUMMARIES = 100
const MAX_TRAINING_NAMES = 3
const MAX_RECENT_DROPS = 3
const MAX_DROPS_PER_RECORD = 3

const firstString = (...values: unknown[]) => values.find(
  (value): value is string => typeof value === 'string' && value.trim().length > 0,
)

const asRecordArray = (value: unknown): Array<Record<string, unknown>> | null => (
  Array.isArray(value) && value.every(isRecord) ? value : null
)

const asStageSummaryArray = (value: unknown): Array<{ stage: string; name: string }> | null => {
  if (!Array.isArray(value) || value.length > MAX_STAGE_SUMMARIES) return null
  if (!value.every(item => isRecord(item) && typeof item.stage === 'string' && typeof item.name === 'string')) {
    return null
  }
  return value.map(item => ({ stage: item.stage as string, name: item.name as string }))
}

const formatDropItems = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value
    .slice(0, MAX_DROPS_PER_RECORD)
    .map((drop: any) => `${drop?.name || drop?.itemName || '材料'}×${drop?.count || 1}`)
    .join('、')
}

const normalizeDropRecord = (record: Record<string, unknown>) => ({
  stage: firstString(record.stageName, record.stageCode, record.stage) || '未知关卡',
  items: formatDropItems(record.drops)
    || formatDropItems(record.items)
    || firstString(record.itemName)
    || '已记录作战，暂无材料明细',
})

/**
 * 五路载荷全部有效时返回完整快照；任一路缺失或格式不符返回 `null`。
 * 调用方不得用部分成功结果替换 `dashboardStore` 中的上一份快照。
 */
export function normalizeDashboardSnapshot(
  payloads: DashboardSnapshotPayloads,
): DashboardBusinessSnapshot | null {
  const { activity, scheduleExecution, trainingQueue, todayDrops, openTodayStages } = payloads

  const queue = Array.isArray(trainingQueue)
    ? asRecordArray(trainingQueue)
    : isRecord(trainingQueue)
      ? asRecordArray(trainingQueue.queue)
      : null
  const drops = Array.isArray(todayDrops)
    ? asRecordArray(todayDrops)
    : isRecord(todayDrops)
      ? asRecordArray(todayDrops.records)
      : null
  const openStages = isRecord(openTodayStages) ? asStageSummaryArray(openTodayStages.open) : null
  const closedStages = isRecord(openTodayStages) ? asStageSummaryArray(openTodayStages.closed) : null

  const activityPayload = normalizeActivityPayload(activity)
  const payloadsAreComplete = activityPayload !== null
    && isRecord(scheduleExecution)
    && queue !== null
    && drops !== null
    && openStages !== null
    && closedStages !== null

  if (!payloadsAreComplete) return null

  const activitySummary: ActivitySummary = {
    available: activityPayload.available,
    status: activityPayload.status,
    clientType: activityPayload.clientType,
    message: activityPayload.message,
    code: activityPayload.code ?? undefined,
    name: activityPayload.name ?? undefined,
    source: activityPayload.source ?? undefined,
    startTime: activityPayload.startTime ?? undefined,
    endTime: activityPayload.endTime ?? undefined,
    stages: activityPayload.stages,
    lastSuccessAt: activityPayload.lastSuccessAt ?? undefined,
    dataUpdatedAt: activityPayload.dataUpdatedAt ?? undefined,
    failure: activityPayload.failure ?? undefined,
    completion: activityPayload.completion,
  }

  const rawLastResult = scheduleExecution.lastResult
    || scheduleExecution.result
    || scheduleExecution.lastMessage
  const scheduleSummary: ScheduleSummary = {
    isRunning: scheduleExecution.isRunning === true
      || scheduleExecution.running === true
      || scheduleExecution.executing === true,
    currentTask: firstString(
      scheduleExecution.taskName,
      scheduleExecution.currentTask,
      isRecord(scheduleExecution.task) ? scheduleExecution.task.name : undefined,
    ),
    message: firstString(scheduleExecution.message, scheduleExecution.status),
    lastTask: firstString(
      scheduleExecution.lastTaskName,
      scheduleExecution.lastTask,
      scheduleExecution.completedTask,
    ) || getExecutionLastTask(rawLastResult),
    lastResult: formatExecutionSummary(rawLastResult),
  }

  const trainingSummary: TrainingSummary = {
    count: queue.length,
    topNames: queue
      .map(item => firstString(
        item.operatorName,
        isRecord(item.operator) ? item.operator.name : undefined,
        item.name,
        item.nickname,
      ))
      .filter((name): name is string => Boolean(name))
      .slice(0, MAX_TRAINING_NAMES),
  }

  const dropSummary: DropSummary = {
    count: drops.length,
    recent: [...drops].reverse().slice(0, MAX_RECENT_DROPS).map(normalizeDropRecord),
  }

  return {
    activitySummary,
    scheduleSummary,
    trainingSummary,
    dropSummary,
    openStageSummary: {
      open: openStages,
      closed: closedStages,
    },
  }
}
