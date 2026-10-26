/**
 * 日志页会话组合
 *
 * 本 hook 把实时流、历史会话与清理命令组合成页面唯一的状态协议：
 *
 * - `enterHistory(file)`：先停止实时轮询并取消在途读取、清空实时缓冲，再
 *   进入历史选择。历史读取从此只写历史快照，不会回填实时缓冲。
 * - `backToRealtime()`：退出历史并清空选择；实时轮询由 `enabled` 从 false
 *   恢复为 true 时立即重读，不需要页面手动调用 `start()`，也不会在历史
 *   模式里绕过页面级停用。
 * - 清空实时日志只在实时模式可用；清理历史不触碰实时缓冲。
 * - 两个命令共用一个在途槽位，命令执行期间页面按钮保持禁用；命令结论交
 *   页面展示，失败仍由确认弹层重抛以保留可重试的打开状态。
 */

import { useCallback, useRef, useState } from 'react'
import {
  clearRealtimeLogsCommand,
  cleanupHistoryLogsCommand,
  type LogCommandOutcome,
} from '../model/logCommands'
import type { LogFile } from '../types'
import { useHistoryLogs, type UseHistoryLogsResult } from './useHistoryLogs'
import { useRealtimeLogs, type UseRealtimeLogsResult } from './useRealtimeLogs'

export type LogsCommandKind = 'clear-realtime' | 'cleanup-history'

export interface UseLogsSessionResult {
  readonly realtime: UseRealtimeLogsResult
  readonly history: UseHistoryLogsResult
  readonly commandPending: LogsCommandKind | null
  readonly enterHistory: (file: LogFile) => void
  readonly backToRealtime: () => void
  readonly clearRealtimeLogs: () => Promise<LogCommandOutcome>
  readonly cleanupHistoryLogs: () => Promise<LogCommandOutcome>
}

export function useLogsSession(): UseLogsSessionResult {
  const history = useHistoryLogs()
  const realtime = useRealtimeLogs({ enabled: !history.viewing })
  const [commandPending, setCommandPending] = useState<LogsCommandKind | null>(null)
  const commandRef = useRef<LogsCommandKind | null>(null)

  const { selectFile, backToRealtime: leaveHistory } = history
  const { stop, clear, pause, resume } = realtime

  const enterHistory = useCallback((file: LogFile) => {
    stop()
    clear()
    selectFile(file)
  }, [clear, selectFile, stop])

  const backToRealtime = useCallback(() => {
    leaveHistory()
  }, [leaveHistory])

  const clearRealtimeLogs = useCallback(async (): Promise<LogCommandOutcome> => {
    if (history.viewing || commandRef.current !== null) return { status: 'ignored' }
    commandRef.current = 'clear-realtime'
    setCommandPending('clear-realtime')
    try {
      return await clearRealtimeLogsCommand({ pause, resume, clear })
    } finally {
      commandRef.current = null
      setCommandPending(null)
    }
  }, [clear, history.viewing, pause, resume])

  const cleanupHistoryLogs = useCallback(async (): Promise<LogCommandOutcome> => {
    if (commandRef.current !== null) return { status: 'ignored' }
    commandRef.current = 'cleanup-history'
    setCommandPending('cleanup-history')
    try {
      return await cleanupHistoryLogsCommand({
        reloadFiles: history.reloadFiles,
        reconcileSelection: history.reconcileSelection,
      })
    } finally {
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
    clearRealtimeLogs,
    cleanupHistoryLogs,
  }
}
