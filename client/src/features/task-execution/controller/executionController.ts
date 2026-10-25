/**
 * 应用级执行控制器
 *
 * 唯一职责：保存调用方自己的 runId，按 Run 快照观察执行，并按 runId 停止。
 * 它不属于任何页面：页面隐藏、Activity 清理或订阅者卸载都不改变它的观察循环。
 * 控制器不写 runtime-status 的 statusStore，也不把“进程 idle / 请求失败”解释成完成。
 */

import { getErrorMessage, type ApiResponse } from '@/shared/api'
import { getRun, getRunSnapshot, stopRun } from '../api'
import {
  findRunById,
  isActiveRunState,
  isTerminalRunState,
  readSubmittedRun,
  readSubmittedRunId,
  type AgentRun,
  type RunOccupancy,
  type RunSnapshot,
  type StopRunResult,
} from '../types'

export const ACTIVE_RUN_POLL_INTERVAL_MS = 2_000
export const IDLE_RUN_POLL_INTERVAL_MS = 30_000
export const DISCONNECTED_RUN_POLL_INTERVAL_MS = 10_000

const IDENTITY_STORAGE_KEY = 'la-pluma-execution-identity-v1'
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/

export type ExecutionObservationPhase =
  | 'idle'
  | 'syncing'
  | 'live'
  | 'disconnected'
  | 'offline'
  | 'suspended'

/**
 * `none`：没有本客户端的 run 身份；`tracked`：持有并观察一个 runId；
 * `unknown`：服务端按 id 查不到该 run（过期或未知），既不能当作成功，也不能当作失败。
 */
export type ExecutionIdentityState = 'none' | 'tracked' | 'unknown'

/**
 * 最近一次逻辑提交的结果。任何传输失败（断线、超时、本地 abort）都只能是 `unknown`：
 * 请求可能已经到达服务端，不能据此重新提交或宣称失败。
 */
export type ExecutionSubmissionState = 'idle' | 'pending' | 'accepted' | 'rejected' | 'unknown'

export interface ExecutionControllerState {
  readonly phase: ExecutionObservationPhase
  readonly identity: ExecutionIdentityState
  readonly submission: ExecutionSubmissionState
  readonly snapshot: RunSnapshot | null
  readonly trackedRunId: string | null
  readonly trackedRun: AgentRun | null
  readonly lastError: string | null
  readonly lastSyncedAt: number | null
  readonly hasActiveRun: boolean
  readonly occupancy: RunOccupancy | null
}

export interface ExecutionIntent {
  readonly operationId: string
  readonly idempotencyKey: string
  readonly sequence: number
}

export interface ExecutionIdentity {
  runId: string
  operationId: string | null
}

export interface ExecutionIdentityStorage {
  read(): ExecutionIdentity | null
  write(identity: ExecutionIdentity | null): void
}

export interface ExecutionControllerApi {
  fetchSnapshot: (signal?: AbortSignal) => Promise<ApiResponse<RunSnapshot>>
  fetchRun: (runId: string, signal?: AbortSignal) => Promise<ApiResponse<AgentRun>>
  stopRun: (runId: string) => Promise<ApiResponse<StopRunResult>>
}

export interface ExecutionControllerOptions {
  api?: Partial<ExecutionControllerApi>
  storage?: ExecutionIdentityStorage | null
  intervals?: Partial<Record<'active' | 'idle' | 'disconnected', number>>
}

type RefreshReason =
  | 'manual'
  | 'startup'
  | 'poll'
  | 'reconnect'
  | 'resume'
  | 'submission'
  | 'stop'
  | 'observation'

function createInitialState(): ExecutionControllerState {
  return Object.freeze({
    phase: 'idle' as const,
    identity: 'none' as const,
    submission: 'idle' as const,
    snapshot: null,
    trackedRunId: null,
    trackedRun: null,
    lastError: null,
    lastSyncedAt: null,
    hasActiveRun: false,
    occupancy: null,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRunSnapshot(value: unknown): value is RunSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Partial<RunSnapshot>
  return Array.isArray(snapshot.activeRuns)
    && Boolean(snapshot.occupancy && typeof snapshot.occupancy === 'object')
}

function createNoopStorage(): ExecutionIdentityStorage {
  return { read: () => null, write: () => undefined }
}

export function createExecutionIdentityStorage(
  storage?: Storage | null,
): ExecutionIdentityStorage {
  const target = storage === undefined
    ? (typeof localStorage === 'undefined' ? null : localStorage)
    : storage
  if (!target) return createNoopStorage()

  return {
    read() {
      try {
        const raw = target.getItem(IDENTITY_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<ExecutionIdentity>
        if (typeof parsed?.runId !== 'string' || !parsed.runId.trim()) return null
        return {
          runId: parsed.runId,
          operationId: typeof parsed.operationId === 'string' ? parsed.operationId : null,
        }
      } catch {
        return null
      }
    },
    write(identity) {
      try {
        if (identity) target.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
        else target.removeItem(IDENTITY_STORAGE_KEY)
      } catch {
        // 存储不可用（隐私模式、配额）不能让执行身份失效；会话内仍持有内存身份。
      }
    },
  }
}

function sanitizeKeyPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._~:-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')
  return normalized.slice(0, 40) || 'execution'
}

/**
 * 生成服务端接受的幂等键。键按 operationId 分区，因此同一操作重试必须复用同一个键，
 * 不同逻辑提交才需要新键。
 */
export function createIdempotencyKey(operationId: string, now = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 10)
  const key = `${sanitizeKeyPart(operationId)}-${now.toString(36)}-${random}`
  return key.slice(0, 128)
}

export class ExecutionController {
  private readonly api: ExecutionControllerApi
  private readonly storage: ExecutionIdentityStorage
  private readonly intervals: Record<'active' | 'idle' | 'disconnected', number>

  private state: ExecutionControllerState = createInitialState()
  private readonly listeners = new Set<() => void>()

  private starts = 0
  private active = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: { sequence: number; controller: AbortController } | null = null
  private sequence = 0
  private intentSequence = 0
  private latestIntentSequence = 0

  private snapshot: RunSnapshot | null = null
  private trackedRunId: string | null = null
  private trackedRun: AgentRun | null = null
  private identity: ExecutionIdentityState = 'none'
  private submission: ExecutionSubmissionState = 'idle'
  private phase: ExecutionObservationPhase = 'idle'
  private lastError: string | null = null
  private lastSyncedAt: number | null = null

  constructor(options: ExecutionControllerOptions = {}) {
    this.api = {
      fetchSnapshot: options.api?.fetchSnapshot ?? getRunSnapshot,
      fetchRun: options.api?.fetchRun ?? getRun,
      stopRun: options.api?.stopRun ?? stopRun,
    }
    this.storage = options.storage === undefined
      ? createExecutionIdentityStorage()
      : (options.storage ?? createNoopStorage())
    this.intervals = {
      active: options.intervals?.active ?? ACTIVE_RUN_POLL_INTERVAL_MS,
      idle: options.intervals?.idle ?? IDLE_RUN_POLL_INTERVAL_MS,
      disconnected: options.intervals?.disconnected ?? DISCONNECTED_RUN_POLL_INTERVAL_MS,
    }
  }

  readonly getState = (): ExecutionControllerState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 引用计数启动：多个应用级/订阅入口同时使用时，只有最后一个释放才停止观察。
   * 返回的清理函数只影响本地观察，不发送任何停止请求。
   */
  start(): () => void {
    this.starts += 1
    if (this.starts === 1) {
      this.activate()
    } else if (this.active && this.phase === 'suspended') {
      void this.refresh('resume')
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.starts = Math.max(0, this.starts - 1)
      if (this.starts === 0) this.deactivate()
    }
  }

  /**
   * 本地中止观察：取消在途请求和定时器，保留最后快照与 run 身份。
   * 这不是停止后台任务；停止必须调用 stopTrackedRun（或传入 runId 的 stopRun）。
   */
  abortObservation(): void {
    this.abortInFlight()
    this.clearPollTimer()
    if (this.active && this.phase !== 'idle') {
      this.setPhase('suspended', this.lastError)
    }
  }

  resumeObservation(): void {
    if (!this.active) return
    if (this.isOffline()) {
      this.setPhase('offline', '当前网络已断开，执行状态未知')
      return
    }
    void this.refresh('resume')
  }

  /**
   * 观察指定 run。传入 null 只解除本客户端的身份绑定，不停止任何执行。
   */
  observeRun(runId: string | null, operationId: string | null = null): void {
    if (!runId) {
      this.trackedRunId = null
      this.trackedRun = null
      this.identity = 'none'
      this.storage.write(null)
      this.publish()
      return
    }

    this.trackedRunId = runId
    this.trackedRun = findRunById(this.snapshot, runId)
      ?? (this.trackedRun?.runId === runId ? this.trackedRun : null)
    this.identity = 'tracked'
    this.lastError = null
    this.storage.write({ runId, operationId })
    this.publish()
    this.requestRefresh('observation')
  }

  /**
   * 开始一次逻辑提交并分配幂等键。重试同一逻辑动作时必须复用返回的 intent。
   */
  beginExecutionIntent(
    operationId: string,
    options: { idempotencyKey?: string } = {},
  ): ExecutionIntent {
    const suppliedKey = options.idempotencyKey?.trim()
    const idempotencyKey = suppliedKey || createIdempotencyKey(operationId)
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new Error('幂等键格式不合法：只允许字母、数字和 . _ ~ : -，最长 128 个字符')
    }

    const sequence = ++this.intentSequence
    this.latestIntentSequence = sequence
    this.submission = 'pending'
    this.publish()
    return { operationId, idempotencyKey, sequence }
  }

  /**
   * 收敛提交响应。只有最新 intent 的响应可以更新身份：
   * 旧提交即使更晚返回，也不能覆盖新 run。
   */
  settleExecutionIntent(
    intent: ExecutionIntent,
    result: ApiResponse<unknown> | null,
    error?: unknown,
  ): boolean {
    if (intent.sequence !== this.latestIntentSequence) return false

    if (result?.success) {
      const runId = readSubmittedRunId(result.data)
      // 旧同步响应可能没有身份；不据此伪造 runId，也不清除已有身份。
      if (!runId) {
        this.submission = 'accepted'
        this.publish()
        return false
      }

      this.submission = 'accepted'
      this.trackedRunId = runId
      this.trackedRun = readSubmittedRun(result.data, runId) ?? findRunById(this.snapshot, runId)
      this.identity = 'tracked'
      this.lastError = null
      this.storage.write({ runId, operationId: intent.operationId })
      this.publish()
      this.requestRefresh('submission')
      return true
    }

    if (result && !result.success) {
      this.submission = 'rejected'
      this.lastError = getErrorMessage(result)
      this.publish()
      return false
    }

    // 没有服务端响应的失败（断线、超时、本地 abort）都是未知：
    // 服务端可能已经接受执行，不能据此重新提交或宣称失败。
    this.submission = 'unknown'
    if (error && !isAbortError(error)) {
      this.lastError = error instanceof Error ? error.message : '提交执行失败'
    }
    this.publish()
    return false
  }

  /**
   * 为不走 intent 的执行端点（日常流程、作业集等）采纳响应中的 run 身份。
   */
  adoptSubmission(result: ApiResponse<unknown>, operationId: string): string | null {
    if (!result.success) {
      this.submission = 'rejected'
      this.lastError = getErrorMessage(result)
      this.publish()
      return null
    }

    const runId = readSubmittedRunId(result.data)
    if (!runId) {
      this.submission = 'accepted'
      this.publish()
      return null
    }

    this.submission = 'accepted'
    this.trackedRunId = runId
    this.trackedRun = readSubmittedRun(result.data, runId) ?? findRunById(this.snapshot, runId)
    this.identity = 'tracked'
    this.lastError = null
    this.storage.write({ runId, operationId })
    this.publish()
    this.requestRefresh('submission')
    return runId
  }

  /**
   * 提交一次执行：生成幂等键、转发本地 AbortSignal、收敛 runId。
   * 本地 signal 中止不等于停止服务端执行。
   */
  async submitExecution<Data = unknown>(
    operationId: string,
    request: (context: { idempotencyKey: string; signal?: AbortSignal }) => Promise<ApiResponse<Data>>,
    options: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<ApiResponse<Data>> {
    const intent = this.beginExecutionIntent(operationId, options)
    try {
      const result = await request({ idempotencyKey: intent.idempotencyKey, signal: options.signal })
      this.settleExecutionIntent(intent, result)
      return result
    } catch (error) {
      this.settleExecutionIntent(intent, null, error)
      throw error
    }
  }

  /**
   * 按本客户端持有的 runId 停止。没有身份时返回 null，绝不退化为“停止当前任务”。
   */
  async stopTrackedRun(): Promise<ApiResponse<StopRunResult> | null> {
    const runId = this.trackedRunId
    if (!runId) return null

    const result = await this.api.stopRun(runId)
    if (result.success && result.data?.run && typeof result.data.run.runId === 'string') {
      this.applyRun(result.data.run)
    } else if (result.errorInfo?.code === 'AGENT_RUN_NOT_FOUND') {
      this.markIdentityUnknown()
    } else if (!result.success) {
      this.lastError = getErrorMessage(result)
      this.publish()
    }
    this.requestRefresh('stop')
    return result
  }

  /**
   * 主动刷新快照。`reconnect` 会先按已知 runId 查询，再读取全局快照。
   */
  async refresh(reason: RefreshReason = 'manual'): Promise<void> {
    if (this.isOffline()) {
      this.clearPollTimer()
      this.setPhase('offline', '当前网络已断开，执行状态未知')
      return
    }

    this.abortInFlight()
    const sequence = ++this.sequence
    const controller = new AbortController()
    this.inFlight = { sequence, controller }
    if (!this.snapshot) this.setPhase('syncing', null)

    try {
      if ((reason === 'reconnect' || reason === 'resume') && this.trackedRunId) {
        const runResult = await this.api.fetchRun(this.trackedRunId, controller.signal)
        if (!this.isCurrent(sequence)) return
        this.applyRunResponse(runResult)
      }

      const snapshotResult = await this.api.fetchSnapshot(controller.signal)
      if (!this.isCurrent(sequence)) return
      await this.applySnapshotResponse(snapshotResult, sequence, controller.signal, reason)
    } catch (error) {
      if (!this.isCurrent(sequence) || isAbortError(error)) return
      this.markDisconnected(error)
    } finally {
      if (this.inFlight?.sequence === sequence) this.inFlight = null
      if (this.isCurrent(sequence)) this.scheduleNextPoll()
    }
  }

  private activate(): void {
    if (this.active) return
    this.active = true

    if (!this.trackedRunId) {
      const stored = this.storage.read()
      if (stored) {
        this.trackedRunId = stored.runId
        this.identity = 'tracked'
        this.publish()
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
      window.addEventListener('focus', this.handleFocus)
    }

    if (this.isOffline()) {
      this.setPhase('offline', '当前网络已断开，执行状态未知')
      return
    }
    void this.refresh('startup')
  }

  private deactivate(): void {
    if (!this.active) return
    this.active = false

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
      window.removeEventListener('focus', this.handleFocus)
    }

    this.clearPollTimer()
    this.abortInFlight()
    if (this.phase !== 'idle') this.setPhase('suspended', this.lastError)
  }

  private readonly handleOnline = (): void => {
    if (!this.active) return
    void this.refresh('reconnect')
  }

  private readonly handleOffline = (): void => {
    if (!this.active) return
    this.abortInFlight()
    this.clearPollTimer()
    this.setPhase('offline', '当前网络已断开，执行状态未知')
  }

  private readonly handleFocus = (): void => {
    if (!this.active || this.isOffline()) return
    void this.refresh('reconnect')
  }

  private async applySnapshotResponse(
    result: ApiResponse<RunSnapshot>,
    sequence: number,
    signal: AbortSignal,
    reason: RefreshReason,
  ): Promise<void> {
    if (!result.success) {
      this.markDisconnected(getErrorMessage(result))
      return
    }
    if (!isRunSnapshot(result.data)) {
      this.markDisconnected('服务端返回的 Run 快照无法识别')
      return
    }

    this.snapshot = result.data
    this.lastError = null
    this.lastSyncedAt = Date.now()
    this.phase = 'live'

    const tracked = findRunById(this.snapshot, this.trackedRunId)
    if (tracked) {
      this.trackedRun = tracked
      this.identity = 'tracked'
      this.persistTrackedRun(tracked)
    }
    this.publish()

    if (!tracked && this.trackedRunId && this.shouldFetchTrackedRun(reason)) {
      const runResult = await this.api.fetchRun(this.trackedRunId, signal)
      if (!this.isCurrent(sequence)) return
      this.applyRunResponse(runResult)
    }
  }

  private shouldFetchTrackedRun(reason: RefreshReason): boolean {
    if (!this.trackedRun) return true
    if (isActiveRunState(this.trackedRun.state)) {
      // 身份已被服务端判定为未知时，轮询不再反复请求 404；重连/新提交时再确认。
      return this.identity !== 'unknown' || reason === 'reconnect' || reason === 'submission'
    }
    return this.identity === 'unknown' && (reason === 'reconnect' || reason === 'submission')
  }

  private applyRunResponse(result: ApiResponse<AgentRun>): void {
    if (result.success && result.data && typeof result.data.runId === 'string') {
      this.applyRun(result.data)
      return
    }

    if (result.errorInfo?.code === 'AGENT_RUN_NOT_FOUND') {
      this.markIdentityUnknown()
      return
    }

    if (!result.success) {
      // 单次身份读取失败不等于执行完成；保留快照与最后已知状态。
      this.lastError = getErrorMessage(result) || this.lastError
      this.publish()
    }
  }

  private applyRun(run: AgentRun): void {
    if (this.trackedRunId && run.runId !== this.trackedRunId) return

    this.trackedRunId = run.runId
    this.trackedRun = run
    this.identity = 'tracked'
    this.lastError = null
    this.persistTrackedRun(run)
    this.publish()
  }

  private persistTrackedRun(run: AgentRun): void {
    // 身份保留到看到终态为止；终态后不再写入新身份，但内存仍可供本次会话展示。
    this.storage.write(isTerminalRunState(run.state)
      ? null
      : { runId: run.runId, operationId: run.operationId })
  }

  private markIdentityUnknown(): void {
    this.identity = 'unknown'
    this.storage.write(null)
    this.publish()
  }

  private markDisconnected(error: unknown): void {
    const message = error instanceof Error && error.message
      ? error.message
      : '暂时无法确认执行状态'
    this.setPhase('disconnected', message)
  }

  private setPhase(phase: ExecutionObservationPhase, error: string | null): void {
    if (this.phase === phase && this.lastError === error) return
    this.phase = phase
    this.lastError = error
    this.publish()
  }

  private publish(): void {
    const trackedActive = this.identity === 'tracked'
      && Boolean(this.trackedRun && isActiveRunState(this.trackedRun.state))

    this.state = {
      phase: this.phase,
      identity: this.identity,
      submission: this.submission,
      snapshot: this.snapshot,
      trackedRunId: this.trackedRunId,
      trackedRun: this.trackedRun,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
      hasActiveRun: Boolean(this.snapshot?.activeRuns?.length) || trackedActive,
      occupancy: this.snapshot?.occupancy ?? null,
    }

    for (const listener of this.listeners) listener()
  }

  private requestRefresh(reason: RefreshReason): void {
    if (!this.active) return
    // 新提交/停止是明确的用户动作，可以结束本地观察的中止态。
    if (this.phase === 'suspended') this.setPhase('syncing', null)
    this.clearPollTimer()
    void this.refresh(reason)
  }

  private scheduleNextPoll(): void {
    this.clearPollTimer()
    if (!this.active || this.phase === 'offline' || this.phase === 'suspended') return

    const delay = this.phase === 'disconnected'
      ? this.intervals.disconnected
      : this.state.hasActiveRun
        ? this.intervals.active
        : this.intervals.idle

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.refresh('poll')
    }, delay)
  }

  private clearPollTimer(): void {
    if (this.pollTimer === null) return
    clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private abortInFlight(): void {
    const inFlight = this.inFlight
    if (!inFlight) return
    this.inFlight = null
    this.sequence += 1
    inFlight.controller.abort()
  }

  private isCurrent(sequence: number): boolean {
    return sequence === this.sequence
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }
}

export const executionController = new ExecutionController()
