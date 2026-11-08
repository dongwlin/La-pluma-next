import type { AgentRun, RunState } from '@/features/task-execution'
import { isActiveRunState, isTerminalRunState } from '@/features/task-execution'
import type {
  CopilotQueueEntryMode,
  CopilotQueueFailurePolicy,
  CopilotQueueRunEntry,
  CopilotQueueRunMode,
} from '../api'
import { parseCopilotUri } from '../utils/copilotUri'
import type { CopilotQueueEntry } from './copilotQueue'
import type { TerminalNotice } from './copilotSetRun'

export type CopilotQueueItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped'

export interface CopilotQueueEntryState {
  status: CopilotQueueItemStatus
  error?: string
}

export interface CopilotQueueTaskResult {
  clientId: string
  itemIndex: number | null
  stage: string | null
  stageId: string | null
  apCost: number | null
  mode: CopilotQueueEntryMode | null
  status: CopilotQueueItemStatus
  error?: string
}

export interface CopilotQueueFailure {
  clientId: string | null
  stage: string | null
  error: string
}

export interface CopilotQueueNextEntry {
  clientId: string
  itemIndex: number | null
  stage: string | null
  mode: CopilotQueueEntryMode | null
}

export interface CopilotQueueRunProjection {
  runId: string
  state: RunState
  isActive: boolean
  isTerminal: boolean
  queueId: string | null
  name: string | null
  mode: CopilotQueueRunMode | null
  failurePolicy: CopilotQueueFailurePolicy | null
  phase: string | null
  isWaiting: boolean
  waitingForNext: boolean
  currentClientId: string | null
  currentItemIndex: number | null
  nextEntry: CopilotQueueNextEntry | null
  taskResults: CopilotQueueTaskResult[]
  statuses: ReadonlyMap<string, CopilotQueueEntryState>
  totalCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  stoppedCount: number
  pendingCount: number
  failures: CopilotQueueFailure[]
  summaryErrors: CopilotQueueFailure[]
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

function normalizeStatus(value: unknown): CopilotQueueItemStatus {
  return value === 'running'
    || value === 'success'
    || value === 'failed'
    || value === 'skipped'
    || value === 'stopped'
    ? value
    : 'pending'
}

function normalizeEntryMode(value: unknown): CopilotQueueEntryMode | null {
  return value === 'normal' || value === 'raid' ? value : null
}

function normalizeRunMode(value: unknown): CopilotQueueRunMode | null {
  if (value === 'manual') return 'manual'
  if (value === 'continuous' || value === 'app' || value === 'cli') return 'continuous'
  return null
}

function normalizeFailurePolicy(value: unknown): CopilotQueueFailurePolicy | null {
  return value === 'stop' || value === 'continue' ? value : null
}

function readTaskResult(value: unknown): CopilotQueueTaskResult | null {
  const entry = asRecord(value)
  if (!entry) return null
  const clientId = asText(entry.clientId)
  if (!clientId) return null
  return {
    clientId,
    itemIndex: asNumber(entry.itemIndex),
    stage: asText(entry.displayStage) ?? asText(entry.stage),
    stageId: asText(entry.stageId),
    apCost: asNumber(entry.apCost),
    mode: normalizeEntryMode(entry.mode),
    status: normalizeStatus(entry.status),
    ...(asText(entry.error) ? { error: asText(entry.error) as string } : {}),
  }
}

function readTaskResults(value: unknown): CopilotQueueTaskResult[] | null {
  if (!Array.isArray(value)) return null
  const results: CopilotQueueTaskResult[] = []
  for (const raw of value) {
    const entry = readTaskResult(raw)
    if (entry) results.push(entry)
  }
  return results
}

function readFailures(value: unknown): CopilotQueueFailure[] {
  if (!Array.isArray(value)) return []
  const failures: CopilotQueueFailure[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    failures.push({
      clientId: asText(entry.clientId),
      stage: asText(entry.stage),
      error: asText(entry.error) ?? '未知错误',
    })
  }
  return failures
}

function readNextEntry(value: unknown): CopilotQueueNextEntry | null {
  const entry = asRecord(value)
  if (!entry) return null
  const clientId = asText(entry.clientId)
  if (!clientId) return null
  return {
    clientId,
    itemIndex: asNumber(entry.itemIndex),
    stage: asText(entry.stage),
    mode: normalizeEntryMode(entry.mode),
  }
}

function traceCounts(results: readonly CopilotQueueTaskResult[], status: CopilotQueueItemStatus): number {
  return results.filter(entry => entry.status === status).length
}

function readCount(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
  key: string,
  results: readonly CopilotQueueTaskResult[],
  status: CopilotQueueItemStatus,
): number {
  return asCount(primary?.[key])
    ?? asCount(fallback?.[key])
    ?? traceCounts(results, status)
}

export function readCopilotQueueRunProjection(run: AgentRun | null): CopilotQueueRunProjection | null {
  if (!run || run.operationId !== 'run_copilot_queue') return null

  const progress = asRecord(run.progress)
  const result = asRecord(run.result)
  const summary = asRecord(result?.summary)
  const isTerminal = isTerminalRunState(run.state)
  const primary = isTerminal ? summary : progress
  const fallback = isTerminal ? progress : summary
  const taskResults = (isTerminal
    ? readTaskResults(summary?.taskResults) ?? readTaskResults(progress?.taskResults)
    : readTaskResults(progress?.taskResults) ?? readTaskResults(summary?.taskResults)) ?? []

  const summaryErrors = readFailures(summary?.errors)
  const statuses = new Map<string, CopilotQueueEntryState>()
  for (const entry of taskResults) {
    statuses.set(entry.clientId, {
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    })
  }
  for (const failure of summaryErrors) {
    if (!failure.clientId) continue
    const state = statuses.get(failure.clientId)
    if (!state || state.status !== 'failed' || state.error) continue
    statuses.set(failure.clientId, { status: state.status, error: failure.error })
  }

  const runningEntry = taskResults.find(entry => entry.status === 'running') ?? null
  const currentClientId = asText(progress?.currentClientId) ?? runningEntry?.clientId ?? null
  const currentEntry = currentClientId
    ? taskResults.find(entry => entry.clientId === currentClientId) ?? null
    : null
  const nextEntry = readNextEntry(progress?.nextEntry)
  const isWaiting = run.state === 'waiting'
  const failures = taskResults
    .filter(entry => entry.status === 'failed')
    .map(entry => ({
      clientId: entry.clientId,
      stage: entry.stage,
      error: entry.error || statuses.get(entry.clientId)?.error || '未知错误',
    }))

  return {
    runId: run.runId,
    state: run.state,
    isActive: isActiveRunState(run.state),
    isTerminal,
    queueId: asText(progress?.queueId) ?? asText(summary?.queueId),
    name: asText(progress?.name) ?? asText(summary?.name),
    mode: normalizeRunMode(primary?.mode) ?? normalizeRunMode(fallback?.mode),
    failurePolicy: normalizeFailurePolicy(primary?.failurePolicy)
      ?? normalizeFailurePolicy(fallback?.failurePolicy),
    phase: asText(progress?.phase),
    isWaiting,
    waitingForNext: isWaiting || nextEntry !== null,
    currentClientId,
    currentItemIndex: currentEntry?.itemIndex ?? runningEntry?.itemIndex ?? null,
    nextEntry,
    taskResults,
    statuses,
    totalCount: asCount(primary?.totalEntries)
      ?? asCount(primary?.totalSteps)
      ?? asCount(fallback?.totalEntries)
      ?? asCount(fallback?.totalSteps)
      ?? taskResults.length,
    successCount: readCount(primary, fallback, 'successCount', taskResults, 'success'),
    failedCount: readCount(primary, fallback, 'failedCount', taskResults, 'failed'),
    skippedCount: readCount(primary, fallback, 'skippedCount', taskResults, 'skipped'),
    stoppedCount: readCount(primary, fallback, 'stoppedCount', taskResults, 'stopped'),
    pendingCount: readCount(primary, fallback, 'pendingCount', taskResults, 'pending'),
    failures,
    summaryErrors,
  }
}

function unquotePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function toCopilotQueueRunEntry(
  entry: CopilotQueueEntry,
  mode: CopilotQueueEntryMode = 'normal',
): CopilotQueueRunEntry | null {
  const entryMode: CopilotQueueEntryMode = entry.presetFormation ? 'normal' : mode
  if (entry.source === 'file') {
    const filename = unquotePath(entry.uri)
    return filename ? { clientId: entry.id, source: 'file', filename, mode: entryMode } : null
  }
  const parsed = parseCopilotUri(entry.uri)
  if (!parsed || parsed.isSet) return null
  const copilotId = Number(parsed.id)
  if (!Number.isInteger(copilotId) || copilotId <= 0) return null
  return { clientId: entry.id, source: 'prts', copilotId, mode: entryMode }
}

export function toCopilotQueueRunEntries(
  entries: readonly CopilotQueueEntry[],
  mode: CopilotQueueEntryMode = 'normal',
): CopilotQueueRunEntry[] {
  const mapped: CopilotQueueRunEntry[] = []
  for (const entry of entries) {
    const runEntry = toCopilotQueueRunEntry(entry, mode)
    if (runEntry) mapped.push(runEntry)
  }
  return mapped
}

export function describeCopilotQueueRunTerminal(
  run: AgentRun,
  projection: CopilotQueueRunProjection,
): TerminalNotice {
  const total = Math.max(projection.totalCount, projection.successCount + projection.failedCount)
  const progress = `${projection.successCount}/${total} 成功`
  const failed = projection.failedCount ? `，${projection.failedCount} 项失败` : ''
  const skipped = projection.skippedCount ? `，跳过 ${projection.skippedCount} 项` : ''

  if (run.state === 'succeeded') {
    if (projection.failedCount > 0) {
      return { message: `作业队列执行完成：${progress}${failed}${skipped}`, type: 'warning' }
    }
    return { message: `作业队列执行完成 (${progress})${skipped}`, type: 'success' }
  }
  if (run.state === 'stopped') {
    return {
      message: projection.successCount || projection.failedCount
        ? `作业队列已终止：${progress}${failed}${skipped}`
        : '作业队列已终止',
      type: 'warning',
    }
  }
  if (run.state === 'failed') {
    return { message: `作业队列执行失败: ${run.error?.message || '任务未能完成'}`, type: 'error' }
  }
  return {
    message: `作业队列已中断: ${run.error?.message || '服务重启后无法确认执行结果'}`,
    type: 'warning',
  }
}
