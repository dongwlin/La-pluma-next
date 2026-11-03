import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  RealtimeLogStream,
  type RealtimeLogStreamState,
} from '../model/realtimeLogStream'

export interface UseRealtimeLogsOptions {
  /** 页面级启用；历史浏览时为 false。默认 true。 */
  readonly enabled?: boolean
  /** 测试或特殊场景注入的流实例；省略时每个页面挂载创建独立实例。 */
  readonly stream?: RealtimeLogStream
}

export interface UseRealtimeLogsResult extends RealtimeLogStreamState {
  readonly start: () => void
  readonly stop: () => void
  readonly refresh: () => void
  readonly pause: () => void
  readonly resume: () => void
  readonly clear: () => void
  readonly reset: () => void
}

export function useRealtimeLogs({
  enabled = true,
  stream,
}: UseRealtimeLogsOptions = {}): UseRealtimeLogsResult {
  const [ownedStream] = useState(() => new RealtimeLogStream())
  const instance = stream ?? ownedStream
  const state = useSyncExternalStore(instance.subscribe, instance.getState, instance.getState)

  useEffect(() => {
    const syncDocumentVisibility = () => {
      instance.setDocumentVisible(document.visibilityState !== 'hidden')
    }

    syncDocumentVisibility()
    document.addEventListener('visibilitychange', syncDocumentVisibility)
    return () => document.removeEventListener('visibilitychange', syncDocumentVisibility)
  }, [instance])

  useEffect(() => {
    if (!enabled) return
    instance.start()
    return () => instance.stop()
  }, [enabled, instance])

  const start = useCallback(() => instance.start(), [instance])
  const stop = useCallback(() => instance.stop(), [instance])
  const refresh = useCallback(() => instance.refresh(), [instance])
  const pause = useCallback(() => instance.pause(), [instance])
  const resume = useCallback(() => instance.resume(), [instance])
  const clear = useCallback(() => instance.clear(), [instance])
  const reset = useCallback(() => instance.reset(), [instance])

  return {
    ...state,
    start,
    stop,
    refresh,
    pause,
    resume,
    clear,
    reset,
  }
}
