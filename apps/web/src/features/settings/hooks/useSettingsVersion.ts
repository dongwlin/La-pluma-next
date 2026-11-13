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
