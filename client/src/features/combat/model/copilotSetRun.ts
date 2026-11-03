import type { AgentRun, RunState } from '@/features/task-execution'
import { isActiveRunState } from '@/features/task-execution'

export type CopilotSetItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped'

export interface CopilotSetEntryProjection {
  key: string | null
  itemIndex: number | null
  copilotId: number | null
  stage: string | null
  mode: string | null
  status: CopilotSetItemStatus
  error?: string
}

export interface CopilotSetFailureSummary {
  itemIndex: number | null
  stage: string | null
  error: string
}

export interface CopilotSetRunProjection {
  runId: string
  state: RunState
  isActive: boolean
  setId: string | null
  name: string | null
  mode: string | null
  raid: 'normal' | 'raid' | 'both' | null
  phase: string | null
  isWaiting: boolean
  waitingForNext: boolean
  currentItemIndex: number | null
  nextEntry: CopilotSetEntryProjection | null
  entries: CopilotSetEntryProjection[]
  /**
   * 同一作业在突袭/普通模式下有多个条目时的展示状态，按最差结果折叠到作业索引。
   * 只有每个模式都成功才折叠为 `success`；单个条目成功不代表作业完成。
   */
  itemStatuses: Map<number, CopilotSetItemStatus>
  /** 本次 Run 涉及的作业数量（突袭+普通只算一个作业）。 */
  itemCount: number
  /**
   * 本次汇总列出的执行条目数（每个模式一条）：本次执行队列 ∪ 本次跳过，
   * 与服务端 `summary.totalEntries` 及 `entries.length` 同源。
   */
  totalCount: number
  /** 本次执行队列的条目数；服务端未投影时为 null，不能回退成 `totalCount`。 */
  queuedCount: number | null
  attemptedCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  stoppedCount: number
  pendingCount: number
  failures: CopilotSetFailureSummary[]
}

// 同一作业在突袭/普通模式下有多个条目时折叠成一条展示状态：执行中 > 失败 >
// 终止 > 全部成功 > 全部跳过 > 待执行。部分模式成功时仍是待执行；单个跳过
// 只说明该模式未执行，不能单独把作业标成已跳过。
function foldItemStatuses(entries: CopilotSetEntryProjection[]): Map<number, CopilotSetItemStatus> {
  const grouped = new Map<number, CopilotSetItemStatus[]>()
  for (const entry of entries) {
    if (entry.itemIndex === null) continue
    const statuses = grouped.get(entry.itemIndex)
    if (statuses) statuses.push(entry.status)
    else grouped.set(entry.itemIndex, [entry.status])
  }
  const folded = new Map<number, CopilotSetItemStatus>()
  for (const [itemIndex, statuses] of grouped) folded.set(itemIndex, foldStatuses(statuses))
  return folded
}

function foldStatuses(statuses: readonly CopilotSetItemStatus[]): CopilotSetItemStatus {
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('stopped')) return 'stopped'
  if (statuses.every(status => status === 'success')) return 'success'
  if (statuses.every(status => status === 'skipped')) return 'skipped'
  return 'pending'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asCount(value: unknown): number | null {
  const numeric = asNumber(value)
  return numeric === null ? null : Math.max(0, Math.trunc(numeric))
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeRaid(value: string | null): 'normal' | 'raid' | 'both' | null {
  return value === 'normal' || value === 'raid' || value === 'both' ? value : null
}

function normalizeItemStatus(value: unknown): CopilotSetItemStatus {
  return value === 'running'
    || value === 'success'
    || value === 'failed'
    || value === 'skipped'
    || value === 'stopped'
    ? value
    : 'pending'
}

function readEntry(value: unknown): CopilotSetEntryProjection | null {
  const entry = asRecord(value)
  if (!entry) return null
  return {
    key: asText(entry.key),
    itemIndex: asNumber(entry.itemIndex),
    copilotId: asNumber(entry.copilotId),
    stage: asText(entry.displayStage) ?? asText(entry.stage),
    mode: asText(entry.mode),
    status: normalizeItemStatus(entry.status),
    ...(asText(entry.error) ? { error: asText(entry.error) as string } : {}),
  }
}

function readEntries(value: unknown): CopilotSetEntryProjection[] {
  if (!Array.isArray(value)) return []
  return value
    .map(readEntry)
    .filter((entry): entry is CopilotSetEntryProjection => entry !== null)
}

function traceStatuses(entries: CopilotSetEntryProjection[], status: CopilotSetItemStatus): number {
  return entries.filter(entry => entry.status === status).length
}

/**
 * 读取一次作业集 Run 的投影。只接受 `run_copilot_set`；其它操作返回 null。
 * 活动期读 `progress`，终态读 `result.summary`；两者缺失时返回结构完整但为空的结果，
 * 不把“看不到进度”解释成完成。
 */
export function readCopilotSetRunProjection(run: AgentRun | null): CopilotSetRunProjection | null {
  if (!run || run.operationId !== 'run_copilot_set') return null

  const progress = asRecord(run.progress)
  const result = asRecord(run.result)
  const summary = asRecord(result?.summary)

  const entries = readEntries(progress?.taskResults).length
    ? readEntries(progress?.taskResults)
    : readEntries(summary?.taskResults)
  const itemStatuses = foldItemStatuses(entries)
  // “已尝试”只统计真正执行过的条目；跳过的条目没有执行，不算在内部。
  const attemptedCount = entries
    .filter(entry => entry.status !== 'pending' && entry.status !== 'skipped')
    .length
  const failures = entries
    .filter(entry => entry.status === 'failed')
    .map(entry => ({
      itemIndex: entry.itemIndex,
      stage: entry.stage,
      error: entry.error || '未知错误',
    }))

  const nextEntry = readEntry(progress?.nextEntry)
  const currentEntry = readEntry(progress?.currentEntry)
  const isActive = isActiveRunState(run.state)
  const isWaiting = run.state === 'waiting'
  const itemCount = new Set(
    entries.map(entry => entry.itemIndex).filter((index): index is number => index !== null),
  ).size

  return {
    runId: run.runId,
    state: run.state,
    isActive,
    setId: asText(progress?.setId) ?? asText(summary?.setId),
    name: asText(progress?.name) ?? asText(summary?.name),
    mode: asText(progress?.mode) ?? asText(summary?.mode),
    raid: normalizeRaid(asText(summary?.raid)),
    phase: asText(progress?.phase),
    isWaiting,
    waitingForNext: isWaiting || Boolean(progress?.nextEntry),
    currentItemIndex: currentEntry?.itemIndex
      ?? entries.find(entry => entry.status === 'running')?.itemIndex
      ?? null,
    nextEntry,
    entries,
    itemStatuses,
    itemCount,
    totalCount: asCount(summary?.totalEntries) ?? entries.length,
    queuedCount: asCount(summary?.queuedEntries) ?? asCount(progress?.totalSteps),
    attemptedCount: asCount(summary?.attemptedCount) ?? attemptedCount,
    successCount: asCount(summary?.successCount) ?? asCount(progress?.successCount) ?? traceStatuses(entries, 'success'),
    failedCount: asCount(summary?.failedCount) ?? asCount(progress?.failedCount) ?? traceStatuses(entries, 'failed'),
    // 服务端尚未投影 skipped 字段时按逐项结果回退统计，缺失就是 0。
    skippedCount: asCount(summary?.skippedCount) ?? asCount(progress?.skippedCount) ?? traceStatuses(entries, 'skipped'),
    stoppedCount: asCount(summary?.stoppedCount) ?? asCount(progress?.stoppedCount) ?? traceStatuses(entries, 'stopped'),
    pendingCount: asCount(summary?.pendingCount) ?? asCount(progress?.pendingCount) ?? traceStatuses(entries, 'pending'),
    failures,
  }
}

export interface TerminalNotice {
  message: string
  type: 'success' | 'warning' | 'error'
}

/**
 * 作业集终态通知。失败数来自 Run 汇总，不依赖页面保存的逐项结果。
 *
 * 成功比例只按本次执行队列计算：跳过的条目没有执行，已尝试数不超过队列，
 * 二者都不能用汇总条目数（含跳过）作分母。
 */
export function describeCopilotSetRunTerminal(
  run: AgentRun,
  projection: CopilotSetRunProjection,
): TerminalNotice {
  const total = Math.max(projection.queuedCount ?? projection.attemptedCount, projection.attemptedCount)
  const progress = `${projection.successCount}/${total} 成功`
  const failed = projection.failedCount ? `，${projection.failedCount} 项失败` : ''
  const skipped = projection.skippedCount ? `，跳过 ${projection.skippedCount} 项` : ''

  if (run.state === 'succeeded') {
    if (projection.failedCount > 0) {
      return { message: `作业集执行完成：${progress}${failed}${skipped}`, type: 'warning' }
    }
    return { message: `作业集执行完成 (${progress})${skipped}`, type: 'success' }
  }
  if (run.state === 'stopped') {
    return {
      message: projection.attemptedCount ? `作业集已终止：${progress}${failed}${skipped}` : '作业集已终止',
      type: 'warning',
    }
  }
  if (run.state === 'failed') {
    // 服务端失败信息已包含未完成项数，不重复拼接。
    return { message: `作业集执行失败: ${run.error?.message || '任务未能完成'}`, type: 'error' }
  }
  return {
    message: `作业集执行已中断: ${run.error?.message || '服务重启后无法确认执行结果'}`,
    type: 'warning',
  }
}

/** 单项作业（`run_task`）的终态通知。作业集 Run 走 `describeCopilotSetRunTerminal`。 */
export function describeCombatTaskTerminal(run: AgentRun, label: string | undefined): TerminalNotice {
  if (run.state === 'succeeded') {
    return { message: label ? `${label} 执行成功` : '任务执行成功', type: 'success' }
  }
  if (run.state === 'stopped') return { message: '自动战斗已终止', type: 'warning' }
  if (run.state === 'failed') {
    return { message: `执行失败: ${run.error?.message || '任务未能完成'}`, type: 'error' }
  }
  return {
    message: `任务已中断: ${run.error?.message || '服务重启后无法确认执行结果'}`,
    type: 'warning',
  }
}
