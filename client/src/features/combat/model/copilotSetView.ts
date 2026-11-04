import type { CopilotRaid, CopilotSetInfo, CopilotSetItem } from '../types'
import {
  pendingCopilotItemIndexes,
  pendingCopilotPlanIndexes,
  requiredCopilotItemModes,
} from './copilotSelection'
import type {
  CopilotSetEntryProjection,
  CopilotSetItemStatus,
  CopilotSetRunProjection,
} from './copilotSetRun'

/**
 * 续跑进度：`completed` 与服务端事实一致（历史已通关 ∪ 本次完成的作业），
 * `skipped`、`failed`、`stopped` 来自本次 Run，`pending` 是页面选择中尚未完成
 * 条件的队列。主动终止单独计数，不与执行失败混为一类；各类互不推导。
 */
export interface CopilotSetProgressCounts {
  readonly total: number
  readonly completed: number
  readonly pending: number
  readonly failed: number
  readonly stopped: number
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
  /** 本次 Run 后满足当前 raid 完成条件的作业索引；只有部分模式成功时不在其中。 */
  readonly runCompletedIndexes: ReadonlySet<number>
  /** 服务端持久化进度中已通关的作业索引；与页面选择无关。 */
  readonly historyCompletedIndexes: ReadonlySet<number>
  readonly progress: CopilotSetProgressCounts
  readonly currentIndex: number | null
  readonly pendingSelectedIndexes: number[]
  readonly pendingSelectedCount: number
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
  const copilots = preview?.type === 'set' ? preview.copilots ?? [] : []
  const entries = activeSetRun?.entries ?? []
  // 历史通关以服务端计划为准：计划仍待执行的作业之外，都属于已通关。
  const planPendingIndexes = new Set(pendingCopilotPlanIndexes(copilots, raid))
  const historyCompletedIndexes = copilots.length
    ? new Set(copilots.map((_, index) => index).filter(index => !planPendingIndexes.has(index)))
    : EMPTY_HISTORY_INDEXES
  const runCompletedIndexes = deriveRunCompletedIndexes(copilots, raid, entries)
  // 本次完成与历史通关都表示“所选模式的完成条件已满足”，才从待执行队列移除。
  const completedIndexes = new Set([...historyCompletedIndexes, ...runCompletedIndexes])
  const pendingSelectedIndexes = pendingCopilotItemIndexes(selected, completedIndexes)
  const progress = deriveProgressCounts(
    copilots.length,
    itemStatuses,
    completedIndexes,
    pendingSelectedIndexes.length,
  )
  // 跳过的条目没有执行，不计入“本次已执行”；同一作业的多个模式只算一次。
  const attemptedIndexes = new Set<number>()
  for (const entry of entries) {
    if (entry.itemIndex === null) continue
    if (entry.status === 'pending' || entry.status === 'skipped') continue
    attemptedIndexes.add(entry.itemIndex)
  }
  const attemptedCount = attemptedIndexes.size

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
    runCompletedIndexes,
    historyCompletedIndexes,
    progress,
    currentIndex,
    pendingSelectedIndexes,
    pendingSelectedCount,
    attemptedCount,
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
 * 本次 Run 的作业级完成：当前 raid 要求的所有模式都由持久化进度或本次成功的
 * 条目模式覆盖。同一作业的普通与突袭条目分开判断，单条成功不能算作业完成。
 *
 * 模式是完成条件的归因键：条目未投影出 `normal`/`raid` 时，无法说明它满足
 * 哪一个模式要求，因此不计入任何模式。缺失事实不能被扩展成两种模式都通过。
 */
function deriveRunCompletedIndexes(
  copilots: readonly CopilotSetItem[],
  raid: CopilotRaid,
  entries: readonly CopilotSetEntryProjection[],
): Set<number> {
  const successModes = new Map<number, Set<'normal' | 'raid'>>()
  for (const entry of entries) {
    if (entry.itemIndex === null || entry.status !== 'success') continue
    if (entry.mode !== 'normal' && entry.mode !== 'raid') continue
    const modes = successModes.get(entry.itemIndex) ?? new Set<'normal' | 'raid'>()
    modes.add(entry.mode)
    successModes.set(entry.itemIndex, modes)
  }

  const completed = new Set<number>()
  copilots.forEach((copilot, index) => {
    const executed = successModes.get(index)
    if (!executed) return
    const modes = new Set<'normal' | 'raid'>(copilot.completedModes ?? [])
    for (const mode of executed) modes.add(mode)
    if (requiredCopilotItemModes(copilot, raid).every(mode => modes.has(mode))) {
      completed.add(index)
    }
  })
  return completed
}

/**
 * 逐作业统计通关事实：完成数与“待执行”同源于已满足完成条件的作业索引，
 * 同一作业既在持久化进度里、又在本场完成时不重复计数。失败、终止与跳过来自
 * 本场 Run，主动终止单列；待执行来自选择队列，不由 total 差额推导。
 */
function deriveProgressCounts(
  total: number,
  statuses: ReadonlyMap<number, CopilotSetItemStatus>,
  completedIndexes: ReadonlySet<number>,
  pendingSelectedCount: number,
): CopilotSetProgressCounts {
  const counts = {
    total,
    completed: 0,
    pending: pendingSelectedCount,
    failed: 0,
    stopped: 0,
    skipped: 0,
  }
  for (let index = 0; index < total; index += 1) {
    const status = statuses.get(index)
    if (status === 'failed') counts.failed += 1
    else if (status === 'stopped') counts.stopped += 1
    else if (completedIndexes.has(index)) counts.completed += 1
    else if (status === 'skipped') counts.skipped += 1
  }
  return counts
}
