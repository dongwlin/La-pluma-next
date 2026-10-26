/**
 * 作业预览会话的 React 适配层
 *
 * 会话实例随页面挂载创建，Activity 隐藏时 `stop()` 取消在途预览，
 * 显示时重新 `start()` 但不自动重放。预览对象、loading 与请求裁决全部由
 * `CopilotPreviewSession` 持有；本 hook 只负责实例寿命、订阅与动作绑定。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CopilotRaid, CopilotSetInfo, CopilotSetItem } from '../types'
import type { CopilotPreviewOutcome } from '../model/copilotPreview'
import {
  CopilotPreviewSession,
  type CopilotPreviewLoadInput,
} from '../model/copilotPreviewSession'

export interface UseCopilotPreviewResult {
  readonly preview: CopilotSetInfo | null
  readonly isLoading: boolean
  readonly load: (input: CopilotPreviewLoadInput) => Promise<CopilotPreviewOutcome>
  readonly refreshSet: (setId: string, raid: CopilotRaid) => Promise<CopilotSetItem[] | null>
  readonly resetProgressView: (setId: string) => void
  readonly cancel: () => void
  readonly clear: () => void
}

export interface UseCopilotPreviewOptions {
  /** 测试或特殊场景注入的会话；省略时每个页面挂载创建独立实例。 */
  readonly session?: CopilotPreviewSession
}

export function useCopilotPreview({
  session,
}: UseCopilotPreviewOptions = {}): UseCopilotPreviewResult {
  const client = useQueryClient()
  const [ownedSession] = useState(() => new CopilotPreviewSession({ client }))
  const instance = session ?? ownedSession
  const state = useSyncExternalStore(instance.subscribe, instance.getState, instance.getState)

  useEffect(() => {
    instance.start()
    return () => instance.stop()
  }, [instance])

  const load = useCallback(
    (input: CopilotPreviewLoadInput) => instance.load(input),
    [instance],
  )
  const refreshSet = useCallback(
    (setId: string, raid: CopilotRaid) => instance.refreshSet(setId, raid),
    [instance],
  )
  const resetProgressView = useCallback(
    (setId: string) => instance.resetProgressView(setId),
    [instance],
  )
  const cancel = useCallback(() => instance.cancel(), [instance])
  const clear = useCallback(() => instance.clear(), [instance])

  return {
    preview: state.preview,
    isLoading: state.loading,
    load,
    refreshSet,
    resetProgressView,
    cancel,
    clear,
  }
}
