import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  HistoryLogSession,
  type HistoryFilesOutcome,
  type HistoryLogState,
} from '../model/historyLogSession'
import type { LogFile } from '../types'

export interface UseHistoryLogsOptions {
  /** 测试或特殊场景注入的会话；省略时每个页面挂载创建独立实例。 */
  readonly session?: HistoryLogSession
}

export interface UseHistoryLogsResult extends HistoryLogState {
  readonly selectFile: (file: LogFile) => void
  readonly backToRealtime: () => void
  readonly reloadFiles: () => Promise<HistoryFilesOutcome>
  readonly retry: () => void
  readonly reconcileSelection: () => boolean
}

export function useHistoryLogs({
  session,
}: UseHistoryLogsOptions = {}): UseHistoryLogsResult {
  const [ownedSession] = useState(() => new HistoryLogSession())
  const instance = session ?? ownedSession
  const state = useSyncExternalStore(instance.subscribe, instance.getState, instance.getState)

  useEffect(() => {
    instance.start()
    return () => instance.stop()
  }, [instance])

  const selectFile = useCallback((file: LogFile) => instance.selectFile(file), [instance])
  const backToRealtime = useCallback(() => instance.backToRealtime(), [instance])
  const reloadFiles = useCallback(() => instance.reloadFiles(), [instance])
  const retry = useCallback(() => instance.retry(), [instance])
  const reconcileSelection = useCallback(
    () => instance.reconcileSelection(),
    [instance],
  )

  return {
    ...state,
    selectFile,
    backToRealtime,
    reloadFiles,
    retry,
    reconcileSelection,
  }
}
