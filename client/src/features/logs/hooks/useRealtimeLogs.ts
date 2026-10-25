/**
 * 实时日志流的 React 适配层
 *
 * 缓冲、计时器与请求控制由 `RealtimeLogStream` 持有；本 hook 只负责实例
 * 寿命、订阅与可见性转发。
 *
 * - Activity 隐藏/页面卸载时 `stop()`：清计时器并取消在途读取，缓冲保留；
 *   恢复时 `start()` 立即重读并重建计时器。
 * - 浏览器文档隐藏时取消在途读取，计时器保留但不发请求；可见时立即重读。
 * - `enabled` 用于历史浏览等页面级暂停场景；关闭时停止轮询，重新开启时
 *   立即重读。它与手动 `pause()` 相互独立。
 *
 * 流实例随页面真正挂载创建，Activity 隐藏不会重建；真正重挂载/刷新后缓冲
 * 重新开始，与迁移前一致。
 */

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

  return {
    ...state,
    start,
    stop,
    refresh,
    pause,
    resume,
    clear,
  }
}
