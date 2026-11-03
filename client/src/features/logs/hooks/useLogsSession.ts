// 页面会话协议：进入历史前先停实时轮询、取消在途读取并清空实时缓冲，历史读取只写
// 历史快照；返回实时会一并恢复手动暂停，再由 `enabled` 重读。清理用单在途槽位，
// 失败保留可重试打开状态；卸载只取消本地等待，服务端已收到的清理不会被撤销。

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
