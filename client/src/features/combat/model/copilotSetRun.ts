/**
 * 作业集 Run 投影
 *
 * 服务端作业集 Run 已持有集合身份与逐项结果：活动期由 `progress` 投影，
 * 终态后由 `result.summary` 保留。页面只读这些事实，不自行推导“下一项”或完成语义。
 */

import type { AgentRun, RunState } from '@/features/task-execution'
import { isActiveRunState } from '@/features/task-execution'

export type CopilotSetItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'stopped'

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
  /** 同一作业在突袭/普通模式下有多个条目时，按最差结果折叠到作业索引。 */
  itemStatuses: Map<number, CopilotSetItemStatus>
  /** 本次 Run 涉及的作业数量（突袭+普通只算一个作业）。 */
  itemCount: number
  /** 本次 Run 涉及的执行条目数量（每个模式一条）。 */
  totalCount: number
  attemptedCount: number
  successCount: number
  failedCount: number
  stoppedCount: number
  pendingCount: number
  failures: CopilotSetFailureSummary[]
}

const ITEM_STATUS_PRIORITY: Record<CopilotSetItemStatus, number> = {
  running: 4,
  failed: 3,
  stopped: 2,
  success: 1,
  pending: 0,
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
  return value === 'running' || value === 'success' || value === 'failed' || value === 'stopped'
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

function foldItemStatuses(entries: CopilotSetEntryProjection[]): Map<number, CopilotSetItemStatus> {
  const folded = new Map<number, CopilotSetItemStatus>()
  for (const entry of entries) {
    if (entry.itemIndex === null) continue
    const current = folded.get(entry.itemIndex)
    if (current === undefined || ITEM_STATUS_PRIORITY[entry.status] > ITEM_STATUS_PRIORITY[current]) {
      folded.set(entry.itemIndex, entry.status)
    }
  }
  return folded
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
  const attemptedCount = entries.filter(entry => entry.status !== 'pending').length
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
    totalCount: asCount(summary?.totalEntries) ?? asCount(progress?.totalSteps) ?? entries.length,
    attemptedCount: asCount(summary?.attemptedCount) ?? attemptedCount,
    successCount: asCount(summary?.successCount) ?? asCount(progress?.successCount) ?? traceStatuses(entries, 'success'),
    failedCount: asCount(summary?.failedCount) ?? asCount(progress?.failedCount) ?? traceStatuses(entries, 'failed'),
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
 */
export function describeCopilotSetRunTerminal(
  run: AgentRun,
  projection: CopilotSetRunProjection,
): TerminalNotice {
  const total = Math.max(projection.totalCount, projection.attemptedCount)
  const progress = `${projection.successCount}/${total} 成功`
  const failed = projection.failedCount ? `，${projection.failedCount} 项失败` : ''

  if (run.state === 'succeeded') {
    if (projection.failedCount > 0) {
      return { message: `作业集执行完成：${progress}${failed}`, type: 'warning' }
    }
    return { message: `作业集执行完成 (${progress})`, type: 'success' }
  }
  if (run.state === 'stopped') {
    return {
      message: projection.attemptedCount ? `作业集已终止：${progress}${failed}` : '作业集已终止',
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
