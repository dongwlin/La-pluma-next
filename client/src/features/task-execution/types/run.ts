/**
 * 运行快照类型
 * 与 server/routes/agentContract.js 的 Run / RunSnapshot / RunOccupancy schema 对齐。
 * 这些类型只描述服务端事实；页面和控制器不得自行推导出额外的运行状态。
 */

export const ACTIVE_RUN_STATES = ['accepted', 'waiting', 'running', 'stopping'] as const
export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'stopped', 'interrupted'] as const

export type ActiveRunState = (typeof ACTIVE_RUN_STATES)[number]
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number]
export type RunState = ActiveRunState | TerminalRunState

const ACTIVE_RUN_STATE_SET: ReadonlySet<string> = new Set(ACTIVE_RUN_STATES)
const TERMINAL_RUN_STATE_SET: ReadonlySet<string> = new Set(TERMINAL_RUN_STATES)

export function isActiveRunState(state: unknown): state is ActiveRunState {
  return typeof state === 'string' && ACTIVE_RUN_STATE_SET.has(state)
}

export function isTerminalRunState(state: unknown): state is TerminalRunState {
  return typeof state === 'string' && TERMINAL_RUN_STATE_SET.has(state)
}

export interface RunLinks {
  self: string
  stop?: string
}

export interface RunTaskResult {
  index?: number
  itemIndex?: number
  name?: string
  status?: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped'
  error?: string
  [key: string]: unknown
}

/**
 * 活动 run 的进度投影。字段随 operationId 变化（日常流程、作业集、单任务各用一部分），
 * 因此只固定已知字段并允许服务端继续增字段。
 */
export interface RunProgress {
  scheduleId?: string | null
  currentStep?: number | null
  totalSteps?: number | null
  currentTask?: string | null
  nextEntry?: unknown
  shouldStop?: boolean
  phase?: 'starting' | 'running' | 'waiting_for_next' | string
  message?: string
  taskResults?: RunTaskResult[]
  [key: string]: unknown
}

export interface RunError {
  code?: string
  message?: string
  details?: Record<string, unknown>
  retryable?: boolean
  statusCode?: number
}

export interface RunRecovery {
  source?: string
  previousState?: ActiveRunState | null
  executionResumed?: false
  deviceState?: 'unknown'
}

export interface AgentRun {
  runId: string
  operationId: string
  state: RunState
  acceptedAt?: string
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  progress?: RunProgress
  result?: unknown
  error?: RunError
  recovery?: RunRecovery
  links: RunLinks
  [key: string]: unknown
}

export type RunOccupancyState = 'idle' | 'pending' | 'run' | 'external' | 'unknown'

export interface RunLeaseOwner {
  pid?: number | null
  source?: string | null
  taskName?: string | null
  command?: string | null
  startedAt?: string | null
}

export interface RunLease {
  state: 'free' | 'held' | 'stale' | 'unknown'
  reason?: string | null
  owner?: RunLeaseOwner | null
}

export interface ScheduleExecutionSnapshot {
  isRunning?: boolean
  scheduleId?: string | null
  runId?: string | null
  currentStep?: number | null
  totalSteps?: number
  currentTask?: string | null
  currentTaskId?: string | null
  message?: string
  startTime?: number | null
  shouldStop?: boolean
  lastResult?: unknown
  taskResults?: RunTaskResult[]
  [key: string]: unknown
}

export interface RunOccupancy {
  state: RunOccupancyState
  runId: string | null
  runState: RunState | null
  sources: Array<'run' | 'task' | 'schedule' | 'lease'>
  lease: RunLease
  task: {
    isRunning: boolean
    taskName: string | null
    taskType: string | null
    stopRequested: boolean
  }
  schedule: ScheduleExecutionSnapshot
}

/**
 * `GET /api/agent/runs/current` 的响应。旧客户端字段原样保留，
 * `run`/`activeRuns`/`lastRun`/`occupancy` 是身份与占用事实。
 */
export interface RunSnapshot {
  isRunning?: boolean
  taskName?: string | null
  startTime?: number | null
  taskType?: string | null
  stopRequested?: boolean
  logs?: unknown[]
  schedule?: ScheduleExecutionSnapshot
  recentLogs?: unknown[]
  run: AgentRun | null
  activeRuns: AgentRun[]
  lastRun: AgentRun | null
  occupancy: RunOccupancy
  [key: string]: unknown
}

/** `POST /api/agent/actions/stop` 的 data；旧字段与目标停止结果都保留。 */
export interface StopRunResult {
  stopRequested: boolean
  deviceStopRequested: boolean
  run: AgentRun
  task?: {
    success?: boolean
    message?: string
    [key: string]: unknown
  }
  scheduleStopped?: boolean
  alreadyTerminal?: boolean
  alreadyStopping?: boolean
  acceptedRunCanceled?: boolean
  waitingRunStopped?: boolean
  [key: string]: unknown
}

/** 提交响应的身份字段；旧同步响应也可能完全没有这些字段。 */
export interface RunSubmissionData {
  runId?: string
  state?: RunState
  pollUrl?: string
  stopUrl?: string
  run?: AgentRun
  [key: string]: unknown
}

export function findRunById(snapshot: RunSnapshot | null, runId: string | null): AgentRun | null {
  if (!snapshot || !runId) return null
  const candidates = [snapshot.run, ...(snapshot.activeRuns || []), snapshot.lastRun]
  return candidates.find(run => run?.runId === runId) || null
}

export function readSubmittedRunId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const runId = (data as Record<string, unknown>).runId
  return typeof runId === 'string' && runId.trim() ? runId : null
}

export function readSubmittedRun(data: unknown, runId: string): AgentRun | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const run = (data as Record<string, unknown>).run
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null
  const candidate = run as AgentRun
  return typeof candidate.runId === 'string' && candidate.runId === runId ? candidate : null
}
