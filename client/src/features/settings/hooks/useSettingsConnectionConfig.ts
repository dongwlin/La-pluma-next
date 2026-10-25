/**
 * connection 配置草稿与服务端读取的 React 适配层
 *
 * 服务端副本由 `settings/maa-config` Query 持有，草稿、revision 与保存由
 * 模块级 `ConnectionConfigOwner` 持有。本 hook 只负责订阅、把 Query 快照
 * 交给 owner 裁决，以及暴露编辑/重置/保存入口；Activity 隐藏或 remount
 * 不重建 owner。
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  connectionConfigQueryOptions,
  settingsConnectionOwner,
  type ConnectionConfigOwner,
  type ConnectionConfigSaveOutcome,
  type ConnectionConfigState,
} from '../model/connectionConfig'
import type { MaaConnectionConfig } from '../types'

export interface UseSettingsConnectionConfigResult extends ConnectionConfigState {
  /** 初始读取失败的错误；已有服务端数据或草稿时不再报告后台刷新失败。 */
  readonly loadError: string | null
  readonly update: (patch: Partial<MaaConnectionConfig>) => void
  readonly restoreDefaults: () => boolean
  readonly save: () => Promise<ConnectionConfigSaveOutcome>
  readonly reload: () => Promise<void>
}

const describeLoadError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '连接配置读取失败，请稍后重试'
)

export function useSettingsConnectionConfig(
  owner: ConnectionConfigOwner = settingsConnectionOwner,
  profileName = 'default',
): UseSettingsConnectionConfigResult {
  const options = useMemo(
    () => connectionConfigQueryOptions(profileName, owner),
    [owner, profileName],
  )
  const query = useQuery(options)
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)

  useEffect(() => {
    if (query.data) owner.adoptServer(query.data)
  }, [owner, query.data])

  const update = useCallback((patch: Partial<MaaConnectionConfig>) => {
    owner.update(patch)
  }, [owner])

  const restoreDefaults = useCallback(() => owner.restoreDefaults(), [owner])

  const save = useCallback(() => owner.save(), [owner])

  const reload = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: options.queryKey })
  }, [options.queryKey, queryClient])

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
