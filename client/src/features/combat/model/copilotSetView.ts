/**
 * 作业集视图派生
 *
 * 把“当前预览的作业集 + 页面选择 + 本次 Run 投影”合成列表、进度与信息
 * 面板共用的只读视图。规则与迁移前的页面内计算一致：
 *
 * - 只有属于当前预览作业集、且未被“重置进度”作废的 Run 才提供逐项结果；
 * - “待执行”= 页面选择减去本次 Run 已成功的条目；
 * - 只有等待下一关且未处于按队列策略自动停止时才展示下一关；
 * - 续跑目标是等待项或第一个待执行项，信息面板当前项优先跟随 Run 的当前项；
 * - 失败数按作业索引折叠后的状态计算（完成/失败/终止都算已尝试）。
 *
 * 模型不读取 React、配置通道、Query 或执行控制器。
 */

import type { CopilotSetInfo, CopilotSetItem } from '../types'
import { pendingCopilotItemIndexes } from './copilotSelection'
import type {
  CopilotSetEntryProjection,
  CopilotSetItemStatus,
  CopilotSetRunProjection,
} from './copilotSetRun'

export interface CopilotSetViewInput {
  readonly preview: CopilotSetInfo | null
  readonly selected: ReadonlySet<number>
  readonly setRun: CopilotSetRunProjection | null
  readonly dismissedRunId: string | null
  readonly isWaitingForNext: boolean
  readonly isAutoStopping: boolean
}

export interface CopilotSetView {
  readonly activeSetRun: CopilotSetRunProjection | null
  readonly itemStatuses: ReadonlyMap<number, CopilotSetItemStatus>
  readonly currentIndex: number | null
  readonly pendingSelectedIndexes: number[]
  readonly pendingSelectedCount: number
  readonly failedCount: number
  readonly attemptedCount: number
  readonly waitingEntry: CopilotSetEntryProjection | null
  readonly waitingEntryIndex: number | null
  readonly waitingCopilot: CopilotSetItem | null
  readonly resumeIndex: number
  readonly panelIndex: number
  readonly panelCopilot: CopilotSetItem | null
  readonly selectedCount: number
  readonly completedSelectedCount: number
}

const EMPTY_ITEM_STATUSES: ReadonlyMap<number, CopilotSetItemStatus> = new Map()

export function deriveCopilotSetView({
  preview,
  selected,
  setRun,
  dismissedRunId,
  isWaitingForNext,
  isAutoStopping,
}: CopilotSetViewInput): CopilotSetView {
  // 其它作业集的 Run 或已重置进度的旧 Run 不属于当前预览。
  const activeSetRun = setRun
    && dismissedRunId !== setRun.runId
    && preview?.type === 'set'
    && setRun.setId === preview.id
    ? setRun
    : null

  const itemStatuses = activeSetRun?.itemStatuses ?? EMPTY_ITEM_STATUSES
  const runSuccessIndexes = new Set(
    [...itemStatuses.entries()]
      .filter(([, status]) => status === 'success')
      .map(([index]) => index),
  )
  // “待执行”= 页面选择减去本次 Run 已成功的条目。
  const pendingSelectedIndexes = pendingCopilotItemIndexes(selected, runSuccessIndexes)

  const setWaitingForNext = isWaitingForNext && !isAutoStopping
  const waitingEntry = setWaitingForNext ? activeSetRun?.nextEntry ?? null : null
  const waitingEntryIndex = waitingEntry?.itemIndex ?? null
  const copilots = preview?.type === 'set' ? preview.copilots ?? [] : []
  const waitingCopilot = waitingEntryIndex !== null
    ? copilots[waitingEntryIndex] ?? null
    : null
  const resumeIndex = waitingEntryIndex ?? pendingSelectedIndexes[0] ?? -1

  const currentIndex = activeSetRun?.currentItemIndex ?? null
  const panelIndex = currentIndex ?? (resumeIndex >= 0 ? resumeIndex : 0)
  const selectedCount = selected.size
  const pendingSelectedCount = pendingSelectedIndexes.length

  return {
    activeSetRun,
    itemStatuses,
    currentIndex,
    pendingSelectedIndexes,
    pendingSelectedCount,
    failedCount: countStatuses(itemStatuses, 'failed', 'stopped'),
    attemptedCount: [...itemStatuses.values()].filter(status => status !== 'pending').length,
    waitingEntry,
    waitingEntryIndex,
    waitingCopilot,
    resumeIndex,
    panelIndex,
    // 与原页面一致：当前项越界时回退到第一个作业。
    panelCopilot: copilots[panelIndex] ?? copilots[0] ?? null,
    selectedCount,
    completedSelectedCount: Math.max(0, selectedCount - pendingSelectedCount),
  }
}

function countStatuses(
  statuses: ReadonlyMap<number, CopilotSetItemStatus>,
  ...expected: CopilotSetItemStatus[]
): number {
  return [...statuses.values()].filter(status => expected.includes(status)).length
}
