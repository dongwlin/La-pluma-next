/**
 * 版本资源的 React 适配层
 *
 * 版本由 `settings/version` Query 持有；读取失败保持静默（页面原有行为），
 * `reload()` 供更新流程在成功后失效同一资源：可见时立即重取，Activity
 * 隐藏时保留失效标记，恢复显示后按 `refetchOnMount` 重取。
 */

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { settingsKeys } from '../model/queryKeys'
import { versionQueryOptions, type MaaVersionInfo } from '../model/systemResources'

export interface UseSettingsVersionResult {
  readonly version: MaaVersionInfo | null
  readonly reload: () => Promise<void>
}

export function useSettingsVersion(): UseSettingsVersionResult {
  const query = useQuery(versionQueryOptions())
  const queryClient = useQueryClient()

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: settingsKeys.query('version') })
  }, [queryClient])

  return { version: query.data ?? null, reload }
}
