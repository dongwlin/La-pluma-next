// 历史读取的请求裁决：列表与读取各自持有请求序号和 `AbortController`，新请求、返回
// 实时、切页或 `stop()` 都取消旧请求，只有仍当前且未中止的响应可写；停止时进行中的
// 读取转为 `cancelled`。协议无 cursor/offset：每次读取文件末尾 N 行。

import { isAbortError, isRecord, type ApiResponse } from '@/shared/api'
import {
  getLogFiles as defaultGetLogFiles,
  readLogFile as defaultReadLogFile,
} from '../api'
import { parseHistoryContent } from './logModel'
import type { LogEntry, LogFile } from '../types'

/** 历史文件读取行数；服务端把 lines 限制在 1–5000。 */
export const HISTORY_LOG_LINES = 1000

export type HistoryFilesPhase = 'idle' | 'loading' | 'ready' | 'failed'
export type HistoryReadPhase = 'idle' | 'loading' | 'ready' | 'failed' | 'cancelled'

/** 一次文件列表读取的结论；`cancelled` 不展示为失败。 */
export type HistoryFilesOutcome = 'ready' | 'failed' | 'cancelled'

export interface HistoryLogState {
  readonly viewing: boolean
  readonly files: readonly LogFile[]
  readonly filesPhase: HistoryFilesPhase
  readonly filesError: string | null
  readonly selectedFile: LogFile | null
  readonly logs: readonly LogEntry[]
  readonly readPhase: HistoryReadPhase
  readonly error: string | null
}

export type ListLogFilesRequest = (signal?: AbortSignal) => Promise<ApiResponse<unknown>>
export type ReadLogFileRequest = (
  filePath: string,
  lines?: number,
  signal?: AbortSignal,
) => Promise<ApiResponse<unknown>>

export interface HistoryLogSessionOptions {
  readonly listFiles?: ListLogFilesRequest
  readonly readFile?: ReadLogFileRequest
  readonly lines?: number
}

const DEFAULT_LIST_FALLBACK = '暂时无法获取历史日志'
const DEFAULT_READ_FALLBACK = '读取日志文件失败'

const initialHistoryState = (): HistoryLogState => ({
  viewing: false,
  files: [],
  filesPhase: 'idle',
  filesError: null,
  selectedFile: null,
  logs: [],
  readPhase: 'idle',
  error: null,
})

const responseMessage = (response: ApiResponse<unknown>, fallback: string): string => {
  const message = response.message || response.errorInfo?.message || response.error
  return typeof message === 'string' && message.trim() ? message : fallback
}

const caughtMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

export class HistoryLogSession {
  private readonly listFiles: ListLogFilesRequest
  private readonly readFile: ReadLogFileRequest
  private readonly lines: number

  private state: HistoryLogState = initialHistoryState()
  private readonly listeners = new Set<() => void>()
  private active = false
  private filesController: AbortController | null = null
  private filesRequestId = 0
  private readController: AbortController | null = null
  private readRequestId = 0

  constructor(options: HistoryLogSessionOptions = {}) {
    this.listFiles = options.listFiles ?? defaultGetLogFiles
    this.readFile = options.readFile ?? defaultReadLogFile
    this.lines = options.lines ?? HISTORY_LOG_LINES
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): HistoryLogState => this.state

  /** 页面可见：重读文件列表，并重试被 Activity 隐藏取消的当前读取。 */
  start(): void {
    this.active = true
    void this.reloadFiles()
    if (
      this.state.viewing
      && this.state.selectedFile
      && this.state.readPhase === 'cancelled'
    ) {
      this.startRead(this.state.selectedFile)
    }
  }

  /**
   * 页面隐藏或卸载：取消列表与读取的本地等待，保留选择、已显示内容与
   * 明确失败。进行中的读取转为 `cancelled`，恢复时再重试，不会卡在 loading。
   */
  stop(): void {
    this.active = false
    this.cancelFiles()
    const reading = this.state.readPhase === 'loading'
    this.cancelRead()
    if (reading) {
      this.setState({ ...this.state, readPhase: 'cancelled' })
    }
  }

  /**
   * 读取文件列表。失败保留上一次成功的文件列表并暴露错误；旧请求被取消或
   * 被新请求取代后，其响应不再写状态。
   */
  async reloadFiles(): Promise<HistoryFilesOutcome> {
    if (!this.active) return 'cancelled'

    this.filesController?.abort()
    this.filesController = null
    const controller = new AbortController()
    this.filesController = controller
    const requestId = ++this.filesRequestId
    this.setState({ ...this.state, filesPhase: 'loading', filesError: null })

    try {
      const result = await this.listFiles(controller.signal)
      if (!this.isCurrentFiles(requestId, controller)) return 'cancelled'
      this.filesController = null

      if (!result.success) {
        this.setState({
          ...this.state,
          filesPhase: 'failed',
          filesError: responseMessage(result, DEFAULT_LIST_FALLBACK),
        })
        return 'failed'
      }

      const files = Array.isArray(result.data) ? result.data as LogFile[] : []
      this.setState({
        ...this.state,
        files,
        filesPhase: 'ready',
        filesError: null,
        selectedFile: this.refreshSelectedFile(files, this.state.selectedFile),
      })
      return 'ready'
    } catch (error) {
      if (!this.isCurrentFiles(requestId, controller)) return 'cancelled'
      this.filesController = null
      if (isAbortError(error)) {
        this.setState({ ...this.state, filesPhase: 'idle' })
        return 'cancelled'
      }
      this.setState({
        ...this.state,
        filesPhase: 'failed',
        filesError: caughtMessage(error, DEFAULT_LIST_FALLBACK),
      })
      return 'failed'
    }
  }

  /**
   * 进入历史模式并读取文件。新选择立即取消上一次读取，旧响应不会写入
   * 新选择；实时缓冲由调用方在进入历史前停止并清空。
   */
  selectFile(file: LogFile): void {
    this.cancelRead()
    this.setState({
      ...this.state,
      viewing: true,
      selectedFile: file,
      logs: [],
      readPhase: this.active ? 'idle' : 'cancelled',
      error: null,
    })
    if (this.active) this.startRead(file)
  }

  /** 返回实时：取消在途读取并清空历史选择与内容；实时轮询由页面级启用恢复。 */
  backToRealtime(): void {
    this.cancelRead()
    this.setState({
      ...this.state,
      viewing: false,
      selectedFile: null,
      logs: [],
      readPhase: 'idle',
      error: null,
    })
  }

  /** 错误重试：只重读当前选择；没有选择或不在历史模式时不动。 */
  retry(): void {
    const file = this.state.selectedFile
    if (!this.state.viewing || !file) return
    if (!this.active) {
      if (this.state.readPhase !== 'cancelled') {
        this.setState({ ...this.state, readPhase: 'cancelled' })
      }
      return
    }
    this.startRead(file)
  }

  /**
   * 清理命令成功后的选择裁决：文件列表已确认刷新且当前文件不在其中时，
   * 退出历史模式，避免继续展示已删除文件。普通列表刷新不调用本方法。
   */
  reconcileSelection(): boolean {
    const selected = this.state.selectedFile
    if (!this.state.viewing || !selected || this.state.filesPhase !== 'ready') return false
    if (this.state.files.some(file => file.path === selected.path)) return false
    this.backToRealtime()
    return true
  }

  private startRead(file: LogFile): void {
    this.cancelRead()
    const controller = new AbortController()
    this.readController = controller
    const requestId = ++this.readRequestId
    this.setState({ ...this.state, logs: [], readPhase: 'loading', error: null })
    void this.readInFlight(file, requestId, controller)
  }

  private async readInFlight(
    file: LogFile,
    requestId: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await this.readFile(file.path, this.lines, controller.signal)
      if (!this.isCurrentRead(requestId, controller)) return
      this.readController = null

      if (!result.success) {
        this.setState({
          ...this.state,
          logs: [],
          readPhase: 'failed',
          error: responseMessage(result, DEFAULT_READ_FALLBACK),
        })
        return
      }

      const content = isRecord(result.data) && typeof result.data.content === 'string'
        ? result.data.content
        : ''
      this.setState({
        ...this.state,
        logs: parseHistoryContent(content),
        readPhase: 'ready',
        error: null,
      })
    } catch (error) {
      if (!this.isCurrentRead(requestId, controller)) return
      this.readController = null
      if (isAbortError(error)) {
        this.setState({ ...this.state, readPhase: 'cancelled' })
        return
      }
      this.setState({
        ...this.state,
        logs: [],
        readPhase: 'failed',
        error: caughtMessage(error, DEFAULT_READ_FALLBACK),
      })
    }
  }

  private isCurrentFiles(requestId: number, controller: AbortController): boolean {
    return this.active
      && requestId === this.filesRequestId
      && this.filesController === controller
      && !controller.signal.aborted
  }

  private isCurrentRead(requestId: number, controller: AbortController): boolean {
    return this.active
      && this.state.viewing
      && requestId === this.readRequestId
      && this.readController === controller
      && !controller.signal.aborted
  }

  /** 列表刷新成功后同步当前选择的元数据；文件缺失时由清理裁决决定是否退出。 */
  private refreshSelectedFile(
    files: readonly LogFile[],
    selected: LogFile | null,
  ): LogFile | null {
    if (!selected) return null
    return files.find(file => file.path === selected.path) ?? selected
  }

  private cancelFiles(): void {
    this.filesRequestId += 1
    const controller = this.filesController
    this.filesController = null
    controller?.abort()
    if (this.state.filesPhase === 'loading') {
      this.setState({ ...this.state, filesPhase: 'idle' })
    }
  }

  private cancelRead(): void {
    this.readRequestId += 1
    const controller = this.readController
    this.readController = null
    controller?.abort()
  }

  private setState(next: HistoryLogState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}
