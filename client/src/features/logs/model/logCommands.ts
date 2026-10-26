/**
 * 日志清空与清理命令
 *
 * 两个命令都只影响各自的作用域，并共享同一结论协议：
 * - 清空实时日志：先暂停实时轮询并取消在途读取，服务端确认后只清空实时
 *   缓冲；此前未手动暂停时在 finally 恢复轮询，手动暂停则保持暂停，不静默
 *   解除用户意图。历史文件列表与当前历史选择不变。失败保留原缓冲，下一次
 *   轮询或恢复后的立即读取继续使用服务端快照。
 * - 清理历史文件：服务端确认后刷新文件列表，再按清理结果裁决当前选择；
 *   实时缓冲与轮询不受影响。命令失败不刷新列表，也不改变选择。
 *
 * 命令不持有页面通知与确认弹层：调用方根据结论展示提示，并把失败重新抛给
 * 确认弹层以保留可重试的打开状态。协议没有 cursor/offset，命令协调的是
 * 缓冲、文件列表与当前选择，而不是分页游标。
 */

import { isAbortError, type ApiResponse } from '@/shared/api'
import {
  cleanupLogs as defaultCleanupLogs,
  clearRealtimeLogs as defaultClearRealtimeLogs,
} from '../api'
import type { HistoryFilesOutcome } from './historyLogSession'

/** 与页面既有确认文案一致：只保留最新的 10 MB。 */
export const LOG_CLEANUP_MAX_SIZE_MB = 10

export type LogCommandOutcome =
  | { readonly status: 'succeeded'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'ignored' }

/** 清空实时日志需要协调的实时流动作；不包含历史状态。 */
export interface RealtimeLogCommandPort {
  /** 命令开始前的手动暂停状态；用于决定结束后是否恢复轮询。 */
  readonly paused: boolean
  readonly pause: () => void
  readonly resume: () => void
  readonly clear: () => void
}

/** 清理历史文件需要协调的列表与选择动作；不包含实时缓冲。 */
export interface HistoryLogCommandPort {
  readonly reloadFiles: () => Promise<HistoryFilesOutcome>
  readonly reconcileSelection: () => boolean
}

type ClearRequest = (signal?: AbortSignal) => Promise<ApiResponse<unknown>>
type CleanupRequest = (
  maxSizeMB: number,
  signal?: AbortSignal,
) => Promise<ApiResponse<unknown>>

const responseMessage = (response: ApiResponse<unknown>, fallback: string): string => {
  const message = response.message || response.errorInfo?.message || response.error
  return typeof message === 'string' && message.trim() ? message : fallback
}

const caughtMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

/**
 * 清空实时日志。
 *
 * `finally` 只恢复命令开始前未暂停的轮询；用户手动暂停时清空完成后保持
 * 暂停，避免把“暂停”静默改写成“继续”。只有服务端确认成功才调用 `clear()`，
 * 因此失败不会丢失仍可解释的缓冲。传入的 `signal` 只结束本地等待（例如
 * 页面卸载），不撤销服务端已发出的清空请求。
 */
export async function clearRealtimeLogsCommand(
  realtime: RealtimeLogCommandPort,
  request: ClearRequest = defaultClearRealtimeLogs,
  signal?: AbortSignal,
): Promise<LogCommandOutcome> {
  if (signal?.aborted) return { status: 'cancelled' }
  const wasPaused = realtime.paused
  realtime.pause()
  try {
    const result = await request(signal)
    if (signal?.aborted) return { status: 'cancelled' }
    if (!result.success) {
      return { status: 'failed', message: responseMessage(result, '清空实时日志失败') }
    }
    realtime.clear()
    return { status: 'succeeded', message: result.message || '实时日志已清空' }
  } catch (error) {
    if (isAbortError(error)) return { status: 'cancelled' }
    return { status: 'failed', message: caughtMessage(error, '清空实时日志失败') }
  } finally {
    if (!wasPaused) realtime.resume()
  }
}

/**
 * 清理历史日志文件。
 *
 * 只有在服务端确认清理并成功读取新列表后才裁决当前选择：被删除的选中
 * 文件会退出历史模式，仍存在的文件保持不变。列表读取失败仍视为清理成功
 * （删除已发生），由历史会话展示列表错误并提供重试。取消只结束本地等待，
 * 不再刷新列表或展示失败。
 */
export async function cleanupHistoryLogsCommand(
  history: HistoryLogCommandPort,
  request: CleanupRequest = defaultCleanupLogs,
  signal?: AbortSignal,
): Promise<LogCommandOutcome> {
  if (signal?.aborted) return { status: 'cancelled' }
  try {
    const result = await request(LOG_CLEANUP_MAX_SIZE_MB, signal)
    if (signal?.aborted) return { status: 'cancelled' }
    if (!result.success) {
      return { status: 'failed', message: responseMessage(result, '清理历史日志失败') }
    }

    const filesOutcome = await history.reloadFiles()
    if (filesOutcome === 'ready') history.reconcileSelection()
    return { status: 'succeeded', message: result.message || '历史日志清理完成' }
  } catch (error) {
    if (isAbortError(error)) return { status: 'cancelled' }
    return { status: 'failed', message: caughtMessage(error, '清理历史日志失败') }
  }
}
