import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  resourceSourceQueryOptions,
  settingsResourceSourceOwner,
  type ResourceSourceOwner,
  type ResourceSourceSaveOutcome,
  type ResourceSourceState,
} from '../model/resourceSource'
import type { ResourceSourceDraft } from '../types'

export interface UseSettingsResourceSourceResult extends ResourceSourceState {
  /** 初始读取失败的错误；已有服务端数据或草稿时不再报告后台刷新失败。 */
  readonly loadError: string | null
  readonly update: (patch: Partial<ResourceSourceDraft>) => void
  readonly restoreDefaults: () => boolean
  readonly save: () => Promise<ResourceSourceSaveOutcome>
  readonly reload: () => Promise<void>
}

const describeLoadError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '资源源配置读取失败，请稍后重试'
)

export function useSettingsResourceSource(
  owner: ResourceSourceOwner = settingsResourceSourceOwner,
  enabled = true,
): UseSettingsResourceSourceResult {
  const options = useMemo(() => resourceSourceQueryOptions(owner), [owner])
  // 面板常驻挂载但只有可见 section 需要读取；未启用时不发起请求。
  const query = useQuery({ ...options, enabled })
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)

  useEffect(() => {
    if (query.data) owner.adoptServer(query.data)
  }, [owner, query.data])

  const update = useCallback((patch: Partial<ResourceSourceDraft>) => {
    owner.update(patch)
  }, [owner])

  const restoreDefaults = useCallback(() => owner.restoreDefaults(), [owner])

  const reload = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: options.queryKey })
  }, [options.queryKey, queryClient])

  const save = useCallback(async () => {
    const outcome = await owner.save()
    if (outcome.status === 'saved' && !outcome.superseded) {
      // 保存成功后重新读取：服务端会归一化默认值并只回传凭据形态。
      await queryClient.refetchQueries({ queryKey: options.queryKey })
    }
    return outcome
  }, [options.queryKey, owner, queryClient])

  const loadError = query.isError && !query.data && !state.loaded
    ? describeLoadError(query.error)
    : null

  return {
    ...state,
    loadError,
    update,
    restoreDefaults,
    save,
    reload,
  }
}
