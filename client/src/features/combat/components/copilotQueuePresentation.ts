import type { CopilotDetailTarget } from '../model/copilotDetail'
import type { CopilotQueueEntry, CopilotQueueSource } from '../model/copilotQueue'
import type { CopilotQueueItemStatus } from '../model/copilotQueueRun'
import type { CopilotSetItemStatus } from '../model/copilotSetRun'
import type { CombatCopilotQueueProjection } from './combatPanelTypes'

const SOURCE_LABELS: Record<CopilotQueueSource, string> = {
  link: '链接',
  set: '作业集',
  file: '本地',
}

const STATUS_LABELS: Record<CopilotSetItemStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '待重试',
  skipped: '已跳过',
  stopped: '已终止',
}

const QUEUE_STATUS_LABELS: Record<CopilotQueueItemStatus, string> = {
  ...STATUS_LABELS,
  failed: '执行失败',
}

interface QueueRowState {
  label: string
  error?: string
}

export function describeQueueRowState(
  entry: CopilotQueueEntry,
  queue: CombatCopilotQueueProjection,
): QueueRowState {
  const queueState = queue.queueRun?.statuses.get(entry.id)
  if (queueState) {
    return { label: QUEUE_STATUS_LABELS[queueState.status], error: queueState.error }
  }
  if (entry.setId && entry.setId === queue.setId && entry.setItemIndex !== undefined) {
    const status = queue.itemStatuses.get(entry.setItemIndex)
    if (status) {
      return { label: STATUS_LABELS[status], error: queue.itemErrors.get(entry.setItemIndex) }
    }
  }
  if (queue.isRunning && queue.submittedEntryIds.has(entry.id)) return { label: '本次已提交' }
  return { label: '待执行' }
}

export function describeQueueSource(entry: CopilotQueueEntry): string {
  if (entry.source === 'set' && entry.setId) return `作业集 prts://s${entry.setId}`
  return SOURCE_LABELS[entry.source]
}

export function describeQueueTitle(entry: CopilotQueueEntry): string {
  return entry.title || entry.stage || entry.fileName || entry.uri
}

export function buildQueueDetailTarget(
  entry: CopilotQueueEntry,
  queue: CombatCopilotQueueProjection,
): CopilotDetailTarget {
  const state = describeQueueRowState(entry, queue)
  return {
    title: describeQueueTitle(entry),
    details: entry.details,
    stage: entry.stage,
    stageId: entry.stageId,
    apCost: entry.apCost,
    sourceLabel: describeQueueSource(entry),
    uri: entry.uri,
    presetFormation: entry.presetFormation,
    supportsRaid: entry.supportsRaid,
    recommendedMode: entry.recommendedMode,
    completedModes: entry.completedModes,
    operators: entry.operatorDetails ?? entry.operators?.map(name => ({ name })),
    groups: entry.groups,
    statusLabel: state.label,
    ...(state.error ? { error: state.error } : {}),
  }
}
