/**
 * 作业集视图派生
 *
 * 把“当前预览的作业集 + 页面选择 + 本次 Run 投影”合成列表、进度与信息
 * 面板共用的只读视图。规则与迁移前的页面内计算一致：
 *
 * - 只有属于当前预览作业集、且未被“重置进度”作废的 Run 才提供逐项结果；
 * - “待执行”= 页面选择减去本次 Run 已成功的条目（选择口径，信息面板使用）；
 * - 历史通关只来自服务端持久化的计划进度：`completedModes` 按当前 raid 规则
 *   解释，与页面是否选中无关；
 * - 续跑进度分别统计服务端通关事实（历史已通关与本次成功）、本次失败、本次
 *   跳过与页面选择的待执行队列，不按总数差额反推完成数；
 * - 只有等待下一关且未处于按队列策略自动停止时才展示下一关；
 * - 续跑目标是等待项或第一个待执行项，信息面板当前项优先跟随 Run 的当前项；
 * - 失败数按作业索引折叠后的状态计算（完成/失败/终止都算已尝试）。
 *
 * 模型不读取 React、配置通道、Query 或执行控制器。
 */

import type { CopilotRaid, CopilotSetInfo, CopilotSetItem } from '../types'
import { pendingCopilotItemIndexes, pendingCopilotPlanIndexes } from './copilotSelection'
import type {
  CopilotSetEntryProjection,
  CopilotSetItemStatus,
  CopilotSetRunProjection,
} from './copilotSetRun'

/**
 * 续跑进度：`completed` 与服务端事实一致（历史已通关 ∪ 本次成功），
 * `skipped`、`failed` 来自本次 Run，`pending` 是页面选择中尚未成功的队列。
 * 四类互不推导；跳过不再被算成已通关。
 */
export interface CopilotSetProgressCounts {
  readonly total: number
  readonly completed: number
  readonly pending: number
  readonly failed: number
  readonly skipped: number
}

export interface CopilotSetViewInput {
  readonly preview: CopilotSetInfo | null
  readonly selected: ReadonlySet<number>
  readonly setRun: CopilotSetRunProjection | null
  readonly dismissedRunId: string | null
  readonly raid: CopilotRaid
  readonly isWaitingForNext: boolean
  readonly isAutoStopping: boolean
}

export interface CopilotSetView {
  readonly activeSetRun: CopilotSetRunProjection | null
  readonly itemStatuses: ReadonlyMap<number, CopilotSetItemStatus>
  /** 服务端持久化进度中已通关的作业索引；与页面选择无关。 */
  readonly historyCompletedIndexes: ReadonlySet<number>
  readonly progress: CopilotSetProgressCounts
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
const EMPTY_HISTORY_INDEXES: ReadonlySet<number> = new Set()

export function deriveCopilotSetView({
  preview,
  selected,
  setRun,
  dismissedRunId,
  raid,
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

  const copilots = preview?.type === 'set' ? preview.copilots ?? [] : []
  // 历史通关以服务端计划为准：计划仍待执行的作业之外，都属于已通关。
  const planPendingIndexes = new Set(pendingCopilotPlanIndexes(copilots, raid))
  const historyCompletedIndexes = copilots.length
    ? new Set(copilots.map((_, index) => index).filter(index => !planPendingIndexes.has(index)))
    : EMPTY_HISTORY_INDEXES
  const progress = deriveProgressCounts(
    copilots.length,
    itemStatuses,
    historyCompletedIndexes,
    pendingSelectedIndexes.length,
  )

  const setWaitingForNext = isWaitingForNext && !isAutoStopping
  const waitingEntry = setWaitingForNext ? activeSetRun?.nextEntry ?? null : null
  const waitingEntryIndex = waitingEntry?.itemIndex ?? null
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
    historyCompletedIndexes,
    progress,
    currentIndex,
    pendingSelectedIndexes,
    pendingSelectedCount,
    failedCount: countStatuses(itemStatuses, 'failed', 'stopped'),
    // 跳过的条目没有执行，不计入“本次已执行”。
    attemptedCount: [...itemStatuses.values()]
      .filter(status => status !== 'pending' && status !== 'skipped').length,
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

/**
 * 逐作业统计通关事实：同一作业既在持久化进度里、又在本场成功时不重复计数。
 * 跳过、失败来自本场 Run；待执行来自选择队列，不由 total 差额推导。
 */
function deriveProgressCounts(
  total: number,
  statuses: ReadonlyMap<number, CopilotSetItemStatus>,
  historyCompletedIndexes: ReadonlySet<number>,
  pendingSelectedCount: number,
): CopilotSetProgressCounts {
  const counts = { total, completed: 0, pending: pendingSelectedCount, failed: 0, skipped: 0 }
  for (let index = 0; index < total; index += 1) {
    const status = statuses.get(index)
    if (status === 'success') counts.completed += 1
    else if (status === 'failed' || status === 'stopped') counts.failed += 1
    else if (status === 'skipped') counts.skipped += 1
    else if (historyCompletedIndexes.has(index)) counts.completed += 1
  }
  return counts
}

function countStatuses(
  statuses: ReadonlyMap<number, CopilotSetItemStatus>,
  ...expected: CopilotSetItemStatus[]
): number {
  return [...statuses.values()].filter(status => expected.includes(status)).length
}
