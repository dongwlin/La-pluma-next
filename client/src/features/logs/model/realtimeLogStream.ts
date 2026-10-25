/**
 * 实时日志流所有者
 *
 * 实时日志是会话数据，不是可缓存的普通资源：接口只返回最近 N 行的快照，
 * 没有 cursor/offset，因此本模块按固定节奏重读并整体替换缓冲，不追加、不
 * 进入 Query。
 *
 * 生命周期由页面显式驱动：
 * - `start()`/`stop()` 对应页面 Activity 显示/隐藏；停止时清计时器并取消
 *   在途请求，恢复时立即重读，再按固定间隔轮询。
 * - `setDocumentVisible()` 对应浏览器文档隐藏/可见；隐藏时只取消在途请求，
 *   计时器保留但不再发请求，可见时立即重读。
 * - `pause()`/`resume()` 是手动暂停；暂停状态不会被文档或页面可见性覆盖，
 *   恢复时立即重读。清空实时日志在提交前暂停、成功后清缓冲、finally 恢复。
 *
 * 同一时刻最多一次在途请求：慢请求期间到点的轮询被跳过，不叠加请求。每次
 * 请求持有独立的 AbortController；只有仍是当前请求的响应才能写入状态，
 * 已中止、被新请求取代或隐藏期间返回的旧响应一律丢弃。
 */

import { isAbortError, type ApiResponse } from '@/shared/api'
import { getRealtimeLogs } from '../api'
import { parseRealtimeLog } from './logModel'
import type { LogEntry } from '../types'

/** 实时快照请求行数；服务端把 lines 限制在 1–500。 */
export const REALTIME_LOG_LINES = 200
/** 实时轮询间隔；与迁移前的页面计时器一致。 */
export const REALTIME_LOG_INTERVAL_MS = 1250

export type RealtimeLogReader = (
  lines: number,
  signal?: AbortSignal,
) => Promise<ApiResponse<unknown>>

export interface RealtimeLogStreamOptions {
  readonly read?: RealtimeLogReader
  readonly lines?: number
  readonly intervalMs?: number
}

export interface RealtimeLogStreamState {
  readonly logs: readonly LogEntry[]
  readonly error: string | null
  readonly paused: boolean
}

interface ActiveRequest {
  readonly controller: AbortController
}

const initialRequestFailure = '实时日志请求失败'
const initialReadFailure = '暂时无法获取实时日志'

const readFailureMessage = (response: ApiResponse<unknown>): string => (
  response.message
  || response.errorInfo?.message
  || response.error
  || initialRequestFailure
)

const catchFailureMessage = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : initialReadFailure
)

export class RealtimeLogStream {
  private readonly read: RealtimeLogReader
  private readonly lines: number
  private readonly intervalMs: number

  private state: RealtimeLogStreamState = { logs: [], error: null, paused: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private active: ActiveRequest | null = null
  private started = false
  private documentVisible = true

  constructor(options: RealtimeLogStreamOptions = {}) {
    this.read = options.read ?? getRealtimeLogs
    this.lines = options.lines ?? REALTIME_LOG_LINES
    this.intervalMs = options.intervalMs ?? REALTIME_LOG_INTERVAL_MS
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): RealtimeLogStreamState => this.state

  /** 页面可见：启动计时器并立即重读；重复调用不会叠加计时器。 */
  start(): void {
    this.started = true
    if (this.timer === null) {
      this.timer = setInterval(() => this.fetchIfAllowed(), this.intervalMs)
    }
    this.fetchIfAllowed()
  }

  /** 页面隐藏或卸载：停止轮询并取消在途请求，保留已显示缓冲。 */
  stop(): void {
    this.started = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abortActive()
  }

  /**
   * 浏览器文档可见性。隐藏时取消在途请求；可见时立即重读。
   * 计时器在隐藏期间保留，但 `fetchIfAllowed` 的可见性守卫会跳过发送。
   */
  setDocumentVisible(visible: boolean): void {
    if (this.documentVisible === visible) return
    this.documentVisible = visible
    if (!visible) {
      this.abortActive()
      return
    }
    this.fetchIfAllowed()
  }

  /** 手动暂停：取消在途请求并停止发送；暂停状态不被可见性变化清除。 */
  pause(): void {
    if (this.state.paused) return
    this.abortActive()
    this.setState({ ...this.state, paused: true })
  }

  /** 手动恢复：立即重读一次，之后继续按间隔轮询。 */
  resume(): void {
    if (!this.state.paused) return
    this.setState({ ...this.state, paused: false })
    this.fetchIfAllowed()
  }

  /** 错误重试入口；已有在途请求时保持单在途语义，不抢占。 */
  refresh(): void {
    this.fetchIfAllowed()
  }

  /** 清空本地缓冲；服务端缓存清空由调用方命令成功后调用。 */
  clear(): void {
    if (this.state.logs.length === 0 && this.state.error === null) return
    this.setState({ ...this.state, logs: [], error: null })
  }

  private setState(next: RealtimeLogStreamState): void {
    this.state = next
    this.listeners.forEach(listener => listener())
  }

  private fetchIfAllowed(): void {
    if (!this.started || !this.documentVisible || this.state.paused || this.active) return

    const request: ActiveRequest = { controller: new AbortController() }
    this.active = request
    void this.read(this.lines, request.controller.signal).then(
      response => this.commit(request, response),
      error => this.fail(request, error),
    )
  }

  private isCurrent(request: ActiveRequest): boolean {
    return this.active === request && !request.controller.signal.aborted
  }

  private commit(request: ActiveRequest, response: ApiResponse<unknown>): void {
    if (!this.isCurrent(request)) return
    this.active = null

    if (!response.success) {
      this.setState({ ...this.state, error: readFailureMessage(response) })
      return
    }

    const values = Array.isArray(response.data) ? response.data : []
    this.setState({
      ...this.state,
      logs: values.map(parseRealtimeLog),
      error: null,
    })
  }

  private fail(request: ActiveRequest, error: unknown): void {
    if (!this.isCurrent(request)) return
    this.active = null
    if (isAbortError(error)) return
    this.setState({ ...this.state, error: catchFailureMessage(error) })
  }

  private abortActive(): void {
    const request = this.active
    if (!request) return
    this.active = null
    request.controller.abort()
  }
}
