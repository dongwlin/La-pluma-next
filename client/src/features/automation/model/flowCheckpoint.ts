/**
 * 旧版自动化断点的一次性迁移
 *
 * `localStorage['maa-task-flow-execution']` 是旧版 Automation 页面流程引擎留下的断点，
 * 包含 `isExecuting`、`tasks`、`currentIndex` 与 `startTime`。它没有 runId，不能当作
 * 执行身份；这里只在页面启动时读取一次，尝试关联服务端 Run，然后删除旧键。
 * 无论关联成功与否都不会提交执行——失效或冲突时由用户重新开始。
 */

import {
  isActiveRunState,
  isTerminalRunState,
  type AgentRun,
  type RunSnapshot,
} from '@/features/task-execution'

export const LEGACY_FLOW_EXECUTION_KEY = 'maa-task-flow-execution'

/** 与 Run 终态保留期一致：更早的断点已无法再关联任何记录。 */
export const LEGACY_FLOW_EXECUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000

const LEGACY_FLOW_EXECUTION_VERSION = 1

/** 旧断点写入时间与服务端时间之间允许的时钟/写入偏差。 */
const MATCH_TOLERANCE_MS = 60_000

export interface LegacyFlowCheckpointTask {
  id?: string
  commandId?: string
  name?: string
  enabled?: boolean
}

export interface LegacyFlowCheckpoint {
  version: typeof LEGACY_FLOW_EXECUTION_VERSION
  isExecuting: true
  tasks: LegacyFlowCheckpointTask[]
  currentIndex: number
  startTime: number
}

export type LegacyFlowCheckpointRead =
  | { status: 'absent' }
  | { status: 'invalid'; reason: 'malformed' | 'expired' | 'unsupported' }
  | { status: 'valid'; checkpoint: LegacyFlowCheckpoint }

export type LegacyFlowCheckpointMatch =
  | { status: 'matched'; checkpoint: LegacyFlowCheckpoint; run: AgentRun }
  | {
    status: 'conflict'
    checkpoint: LegacyFlowCheckpoint
    run: AgentRun | null
    reason: 'other-active-run' | 'unmanaged-flow'
  }
  | { status: 'unmatched'; checkpoint: LegacyFlowCheckpoint }

export interface LegacyFlowCheckpointStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

export interface LegacyFlowCheckpointMigration {
  status: 'none' | 'adopted' | 'invalid' | 'unmatched' | 'conflict'
  reason?: 'malformed' | 'expired' | 'unsupported' | 'other-active-run' | 'unmanaged-flow'
  run?: AgentRun
  /** 旧键是否成功删除；失败也不得触发任何新的执行。 */
  removed: boolean
}

function normalizeTasks(value: unknown): LegacyFlowCheckpointTask[] | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const tasks: LegacyFlowCheckpointTask[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.trim() ? record.id : undefined
    const commandId = typeof record.commandId === 'string' && record.commandId.trim()
      ? record.commandId
      : undefined
    if (!id && !commandId) return null

    tasks.push({
      ...(id ? { id } : {}),
      ...(commandId ? { commandId } : {}),
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    })
  }
  return tasks
}

export function readLegacyFlowCheckpoint(raw: string | null, now = Date.now()): LegacyFlowCheckpointRead {
  if (raw === null || raw.trim() === '') return { status: 'absent' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'invalid', reason: 'malformed' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'malformed' }
  }

  const record = parsed as Record<string, unknown>
  if (record.version !== undefined && record.version !== LEGACY_FLOW_EXECUTION_VERSION) {
    return { status: 'invalid', reason: 'unsupported' }
  }
  if (record.isExecuting !== true) return { status: 'invalid', reason: 'malformed' }

  const tasks = normalizeTasks(record.tasks)
  if (!tasks) return { status: 'invalid', reason: 'malformed' }

  const startTime = Number(record.startTime)
  if (!Number.isFinite(startTime) || startTime <= 0) {
    return { status: 'invalid', reason: 'malformed' }
  }
  if (startTime > now + MATCH_TOLERANCE_MS) return { status: 'invalid', reason: 'malformed' }
  if (now - startTime > LEGACY_FLOW_EXECUTION_MAX_AGE_MS) return { status: 'invalid', reason: 'expired' }

  const currentIndex = Number(record.currentIndex)
  return {
    status: 'valid',
    checkpoint: {
      version: LEGACY_FLOW_EXECUTION_VERSION,
      isExecuting: true,
      tasks,
      // 旧值缺失或越界时无法定位“当前项”，但任务列表仍足以判断断点存在。
      currentIndex: Number.isInteger(currentIndex) && currentIndex >= -1 && currentIndex <= tasks.length
        ? currentIndex
        : -1,
      startTime,
    },
  }
}

function activeRunsOf(snapshot: RunSnapshot): AgentRun[] {
  const runs = [snapshot.run, ...(snapshot.activeRuns || [])]
    .filter((run): run is AgentRun => Boolean(run))
  return runs.filter((run, index) => runs.findIndex(candidate => candidate.runId === run.runId) === index)
}

function findTerminalMatch(checkpoint: LegacyFlowCheckpoint, snapshot: RunSnapshot): AgentRun | null {
  const lastRun = snapshot.lastRun
  if (!lastRun || lastRun.operationId !== 'run_daily_flow' || !isTerminalRunState(lastRun.state)) return null

  const startedAt = Date.parse(lastRun.startedAt || lastRun.acceptedAt || '')
  const finishedAt = Date.parse(lastRun.finishedAt || '')
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null

  // 断点写入时该流程必须已经在运行，并在断点之后才结束；否则它不是这份断点对应的执行。
  if (startedAt > checkpoint.startTime + MATCH_TOLERANCE_MS) return null
  if (finishedAt < checkpoint.startTime) return null
  return lastRun
}

export function matchLegacyFlowCheckpoint(
  checkpoint: LegacyFlowCheckpoint,
  snapshot: RunSnapshot,
  trackedRunId: string | null = null,
): LegacyFlowCheckpointMatch {
  const activeRuns = activeRunsOf(snapshot)
  const scheduleRunId = typeof snapshot.schedule?.runId === 'string' && snapshot.schedule.runId
    ? snapshot.schedule.runId
    : null

  const matchRun = (run: AgentRun): LegacyFlowCheckpointMatch => {
    if (trackedRunId && run.runId !== trackedRunId) {
      return { status: 'conflict', checkpoint, run, reason: 'other-active-run' }
    }
    return { status: 'matched', checkpoint, run }
  }

  if (snapshot.schedule?.isRunning) {
    if (!scheduleRunId) {
      // 有流程在跑却没有 Run 身份（外部调用方或旧服务端）：不能把它据为己有。
      return { status: 'conflict', checkpoint, run: null, reason: 'unmanaged-flow' }
    }
    const scheduled = activeRuns.find(run => run.runId === scheduleRunId) || null
    if (!scheduled) {
      return { status: 'conflict', checkpoint, run: null, reason: 'unmanaged-flow' }
    }
    if (scheduled.operationId !== 'run_daily_flow' || !isActiveRunState(scheduled.state)) {
      return { status: 'conflict', checkpoint, run: scheduled, reason: 'other-active-run' }
    }
    return matchRun(scheduled)
  }

  const dailyFlowRuns = activeRuns.filter(run => run.operationId === 'run_daily_flow')
  if (dailyFlowRuns.length > 1) {
    return { status: 'conflict', checkpoint, run: dailyFlowRuns[0] || null, reason: 'other-active-run' }
  }
  if (dailyFlowRuns.length === 1 && dailyFlowRuns[0]) {
    return matchRun(dailyFlowRuns[0])
  }
  if (activeRuns.length > 0) {
    return { status: 'conflict', checkpoint, run: activeRuns[0] || null, reason: 'other-active-run' }
  }

  const terminal = findTerminalMatch(checkpoint, snapshot)
  if (terminal) return matchRun(terminal)

  return { status: 'unmatched', checkpoint }
}

export function migrateLegacyFlowCheckpoint({
  storage,
  snapshot,
  trackedRunId = null,
  now = Date.now(),
}: {
  storage: LegacyFlowCheckpointStorage | null
  snapshot: RunSnapshot
  trackedRunId?: string | null
  now?: number
}): LegacyFlowCheckpointMigration {
  if (!storage) return { status: 'none', removed: false }

  let raw: string | null
  try {
    raw = storage.getItem(LEGACY_FLOW_EXECUTION_KEY)
  } catch {
    return { status: 'none', removed: false }
  }

  const read = readLegacyFlowCheckpoint(raw, now)
  if (read.status === 'absent') return { status: 'none', removed: false }

  let removed = true
  try {
    storage.removeItem(LEGACY_FLOW_EXECUTION_KEY)
  } catch {
    removed = false
  }

  if (read.status === 'invalid') {
    return { status: 'invalid', reason: read.reason, removed }
  }

  const match = matchLegacyFlowCheckpoint(read.checkpoint, snapshot, trackedRunId)
  if (match.status === 'matched') {
    return { status: 'adopted', run: match.run, removed }
  }
  if (match.status === 'conflict') {
    return { status: 'conflict', reason: match.reason, run: match.run || undefined, removed }
  }
  return { status: 'unmatched', removed }
}
