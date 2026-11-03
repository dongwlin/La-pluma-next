/**
 * 日志页会话组合
 *
 * 本 hook 把实时流、历史会话与清理命令组合成页面唯一的状态协议：
 *
 * - `enterHistory(file)`：先停止实时轮询并取消在途读取、清空实时缓冲，再
 *   进入历史选择。历史读取从此只写历史快照，不会回填实时缓冲。
 * - `backToRealtime()`：退出历史并清空选择；进入历史时已清空实时缓冲，
 *   因此返回实时会把手动暂停一并恢复，再由 `enabled` 从 false 恢复为 true
 *   立即重读，避免回到“已暂停且空缓冲”的不可用状态。
 * - 清屏直接设置实时流的本地可见边界；清理历史不触碰实时缓冲。
 * - 历史清理使用一个在途槽位，命令执行期间页面按钮保持禁用；命令结论交
 *   页面展示，失败仍由确认弹层重抛以保留可重试的打开状态。
 * - 页面卸载时取消命令的本地等待；服务端已收到的清理不会被撤销，
 *   重新挂载后按服务端状态重新读取。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cleanupHistoryLogsCommand,
  type LogCommandOutcome,
} from '../model/logCommands'
import type { LogFile } from '../types'
import { useHistoryLogs, type UseHistoryLogsResult } from './useHistoryLogs'
import { useRealtimeLogs, type UseRealtimeLogsResult } from './useRealtimeLogs'

export type LogsCommandKind = 'cleanup-history'

export interface UseLogsSessionResult {
  readonly realtime: UseRealtimeLogsResult
  readonly history: UseHistoryLogsResult
  readonly commandPending: LogsCommandKind | null
  readonly enterHistory: (file: LogFile) => void
  readonly backToRealtime: () => void
  readonly cleanupHistoryLogs: () => Promise<LogCommandOutcome>
}

export function useLogsSession(): UseLogsSessionResult {
  const history = useHistoryLogs()
  const realtime = useRealtimeLogs({ enabled: !history.viewing })
  const [commandPending, setCommandPending] = useState<LogsCommandKind | null>(null)
  const commandRef = useRef<LogsCommandKind | null>(null)
  const commandAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    commandAbortRef.current?.abort()
    commandAbortRef.current = null
  }, [])

  const { selectFile, backToRealtime: leaveHistory } = history
  const { stop, reset, resume } = realtime

  const enterHistory = useCallback((file: LogFile) => {
    stop()
    reset()
    selectFile(file)
  }, [reset, selectFile, stop])

  const backToRealtime = useCallback(() => {
    // 进入历史时缓冲已被清空；保留暂停会让返回实时停留在空列表，因此显式
    // 恢复。此时 started 仍为 false，resume 不会自行发起请求，随后由
    // `enabled` 的 Effect `start()` 立即重读。
    resume()
    leaveHistory()
  }, [leaveHistory, resume])

  const cleanupHistoryLogs = useCallback(async (): Promise<LogCommandOutcome> => {
    if (commandRef.current !== null) return { status: 'ignored' }
    commandRef.current = 'cleanup-history'
    const controller = new AbortController()
    commandAbortRef.current = controller
    setCommandPending('cleanup-history')
    try {
      return await cleanupHistoryLogsCommand(
        {
          reloadFiles: history.reloadFiles,
          reconcileSelection: history.reconcileSelection,
        },
        undefined,
        controller.signal,
      )
    } finally {
      if (commandAbortRef.current === controller) commandAbortRef.current = null
      commandRef.current = null
      setCommandPending(null)
    }
  }, [history.reconcileSelection, history.reloadFiles])

  return {
    realtime,
    history,
    commandPending,
    enterHistory,
    backToRealtime,
    cleanupHistoryLogs,
  }
}
