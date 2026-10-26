/**
 * 作业预览会话所有者
 *
 * 预览的唯一请求入口，负责“当前展示哪一次预览”，不持有搜索词、识别方式或
 * 选中索引：
 *
 * - 每次显式预览取消上一次读取，并只接受仍当前的响应；旧响应不能覆盖新输入。
 * - 取消通过 `AbortController` 与 `cancelQueries(tracked key)` 完成，Query
 *   的 `signal` 会真正传给 fetch；取消不计为失败。
 * - Activity 隐藏/页面卸载调用 `stop()`：取消在途读取并结束 loading，保留
 *   已显示预览；恢复 `start()` 不自动重放上一次请求（与迁移前一致）。
 * - 输入变化时 `clear()` 同时取消并清空预览。
 * - 作业集终态后的 `refreshSet()` 静默强制重读计划/成员，只在当前预览仍是
 *   同一作业集时合并逐项结果并触发选择恢复。
 *
 * 搜索、配置草稿与执行 Run 分别归各自所有者，本会话不读取也不写入它们。
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { ApiFailureKind } from '@/shared/api'
import type { CopilotRaid, CopilotSetInfo, CopilotSetItem } from '../types'
import {
  INVALID_COPILOT_URI_MESSAGE,
  resolveCopilotPreviewTarget,
  type CopilotPreviewMode,
  type CopilotPreviewOutcome,
} from './copilotPreview'
import {
  describeCopilotPreviewFailure,
  loadCopilotPreview,
  type CopilotPreviewLoadOptions,
  type CopilotPreviewLoadRequest,
} from './queries'

export interface CopilotPreviewState {
  readonly preview: CopilotSetInfo | null
  readonly loading: boolean
}

export interface CopilotPreviewLoadInput {
  readonly input: string
  readonly mode: CopilotPreviewMode
  readonly raid: CopilotRaid
}

export type CopilotPreviewLoader = (
  request: CopilotPreviewLoadRequest,
  context: CopilotPreviewLoadOptions,
) => Promise<CopilotPreviewOutcome>

export interface CopilotPreviewSessionOptions {
  readonly client: QueryClient
  /** 测试或特殊场景注入；省略时使用 Query 资源组合读取。 */
  readonly load?: CopilotPreviewLoader
}

const initialPreviewState = (): CopilotPreviewState => ({ preview: null, loading: false })

export class CopilotPreviewSession {
  private readonly client: QueryClient
  private readonly loader: CopilotPreviewLoader

  private state: CopilotPreviewState = initialPreviewState()
  private readonly listeners = new Set<() => void>()
  private active = false
  private requestId = 0
  private controller: AbortController | null = null
  private trackedKeys: QueryKey[] = []

  constructor(options: CopilotPreviewSessionOptions) {
    this.client = options.client
    this.loader = options.load
      ?? ((request, context) => loadCopilotPreview(options.client, request, context))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): CopilotPreviewState => this.state

  /** 页面可见；不重放隐藏前的请求，用户再次预览时才重新读取。 */
  start(): void {
    this.active = true
  }

  /** 页面隐藏或卸载：取消本地等待，保留已显示预览。 */
  stop(): void {
    this.active = false
    this.cancelInFlight()
  }

  /** 取消在途预览；不清空已显示内容。 */
  cancel(): void {
    this.cancelInFlight()
  }

  /** 输入变化或清除预览：取消并清空。 */
  clear(): void {
    this.cancelInFlight()
    this.setState({ preview: null, loading: false })
  }

  /**
   * 读取一次预览。无效输入不发起请求、不改变 loading 或已显示内容。
   * 只有仍当前的结论会写入状态；被新请求取代的旧响应返回 cancelled。
   */
  async load(input: CopilotPreviewLoadInput): Promise<CopilotPreviewOutcome> {
    const target = resolveCopilotPreviewTarget(input.input, input.mode)
    if (!target) return { status: 'invalid', message: INVALID_COPILOT_URI_MESSAGE }

    const outcome = await this.execute(
      { target, raid: input.raid },
      { silent: false, force: false },
    )
    if (outcome.status === 'ready') {
      this.setState({ preview: outcome.preview, loading: false })
    } else if (outcome.status !== 'cancelled') {
      this.setState({ ...this.state, loading: false })
    }
    return outcome
  }

  /**
   * 作业集 Run 终态后的静默刷新：计划进度已由服务端更新，必须绕过默认新鲜期。
   * 只在当前预览仍是同一作业集时合并逐项结果；失败保留旧预览并返回 null。
   */
  async refreshSet(setId: string, raid: CopilotRaid): Promise<CopilotSetItem[] | null> {
    const current = this.state.preview
    if (!this.active || current?.type !== 'set' || current.id !== setId) return null

    const outcome = await this.execute(
      {
        target: { id: setId, kind: 'set', autoAddS: current.autoAddS ?? true },
        raid,
      },
      { silent: true, force: true },
    )
    if (outcome.status !== 'ready' || outcome.preview.type !== 'set') return null
    if (this.state.preview?.id !== setId) return null

    const copilots = outcome.preview.copilots ?? []
    if (!copilots.length) return null
    this.setState({
      ...this.state,
      preview: { ...this.state.preview, copilots, currentIndex: 0 },
    })
    return copilots
  }

  /** 重置进度成功后只更新本地展示，不伪造服务端计划。 */
  resetProgressView(setId: string): void {
    const preview = this.state.preview
    if (!preview || preview.id !== setId) return
    this.setState({ preview: { ...preview, currentIndex: 0 }, loading: this.state.loading })
  }

  private async execute(
    request: CopilotPreviewLoadRequest,
    options: { silent: boolean; force: boolean },
  ): Promise<CopilotPreviewOutcome> {
    this.cancelInFlight()
    if (!this.active) return { status: 'cancelled' }

    const controller = new AbortController()
    const requestId = ++this.requestId
    this.controller = controller
    this.trackedKeys = []
    if (!options.silent) this.setState({ ...this.state, loading: true })

    try {
      const outcome = await this.loader(request, {
        signal: controller.signal,
        force: options.force,
        track: (key) => {
          if (this.controller === controller) this.trackedKeys.push(key)
        },
      })
      if (requestId !== this.requestId) return { status: 'cancelled' }
      return outcome
    } catch (error) {
      if (requestId !== this.requestId || controller.signal.aborted) {
        return { status: 'cancelled' }
      }
      const failure: { message: string; kind: ApiFailureKind | 'unknown' } =
        describeCopilotPreviewFailure(error)
      return { status: 'failed', ...failure }
    } finally {
      if (requestId === this.requestId) {
        this.controller = null
        this.trackedKeys = []
        if (!options.silent) this.setState({ ...this.state, loading: false })
      }
    }
  }

  /**
   * 作废当前请求并取消它登记过的 Query 读取。先推进 request id 再取消，
   * 确保旧 Promise 即使以失败结束也不会写状态；`cancelQueries` 会中止
   * queryFn 里的 fetch signal。
   */
  private cancelInFlight(): void {
    this.requestId += 1
    const controller = this.controller
    this.controller = null
    controller?.abort()

    const keys = this.trackedKeys
    this.trackedKeys = []
    for (const key of keys) {
      void this.client.cancelQueries({ queryKey: key, exact: true })
    }
    if (this.state.loading) this.setState({ ...this.state, loading: false })
  }

  private setState(next: CopilotPreviewState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

