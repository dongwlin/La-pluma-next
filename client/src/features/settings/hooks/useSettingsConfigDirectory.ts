/**
 * 配置目录资源的 React 适配层
 *
 * 路径读取由 `settings/config-directory` Query 持有；页面只渲染状态与重试。
 * “打开目录”是带副作用的命令，不进入 Query，也不自动重取。后台刷新失败时
 * 保留最近一次成功路径，只有从未成功读取过才显示错误。
 */

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getErrorMessage } from '@/shared/api'
import { openConfigDir } from '../api'
import { settingsKeys } from '../model/queryKeys'
import { configDirectoryQueryOptions } from '../model/systemResources'

export type ConfigDirectoryStatus = 'loading' | 'ready' | 'error'

export type OpenConfigDirectoryOutcome =
  | { readonly success: true }
  | { readonly success: false; readonly message: string }

export interface UseSettingsConfigDirectoryResult {
  readonly path: string
  readonly status: ConfigDirectoryStatus
  readonly error: string | null
  readonly reload: () => Promise<void>
  readonly open: () => Promise<OpenConfigDirectoryOutcome>
}

const describeLoadError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '暂时无法读取配置目录'
)

const describeOpenError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '未知错误'
)

export function useSettingsConfigDirectory(): UseSettingsConfigDirectoryResult {
  const query = useQuery(configDirectoryQueryOptions())
  const queryClient = useQueryClient()

  const reload = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: settingsKeys.query('config-directory') })
  }, [queryClient])

  const open = useCallback(async (): Promise<OpenConfigDirectoryOutcome> => {
    try {
      const result = await openConfigDir()
      return result.success
        ? { success: true }
        : { success: false, message: getErrorMessage(result) }
    } catch (error) {
      return { success: false, message: describeOpenError(error) }
    }
  }, [])

  const loaded = query.data !== undefined
  // 手动重试时 Query 仍可能保留上一次错误；只要在取数就回到 loading，
  // 与迁移前“重试即显示正在读取目录”一致。
  const status: ConfigDirectoryStatus = loaded
    ? 'ready'
    : query.isFetching ? 'loading' : query.isError ? 'error' : 'loading'

  return {
    path: query.data ?? '',
    status,
    error: status === 'error' ? `配置目录读取失败: ${describeLoadError(query.error)}` : null,
    reload,
    open,
  }
}
