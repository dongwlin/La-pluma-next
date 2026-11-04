import type { QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/shared/api'
import { probeBackendAvailability, useStatusStore } from '@/features/runtime-status'
import { useDashboardStore } from '../store/dashboardStore'
import { dashboardSnapshotQueryOptions } from './queries'
import type { DashboardBusinessSnapshot } from './snapshot'

export interface DashboardSnapshotRefreshOptions {
  readonly client: QueryClient
  /** 在途刷新结束后再补一次，用于失效、恢复在线与显式操作。 */
  readonly force?: boolean
}

export interface DashboardSnapshotStoreAdapter {
  startRefresh: () => void
  finishRefresh: (attemptedAt: number, snapshot?: DashboardBusinessSnapshot, error?: string) => void
}

export interface DashboardSnapshotRefresherDependencies {
  readonly store: DashboardSnapshotStoreAdapter
  readonly readSnapshot: (client: QueryClient) => Promise<DashboardBusinessSnapshot>
  readonly isOnline: () => boolean
  readonly probeBackend: () => Promise<unknown>
  readonly now: () => number
  readonly logError: (message: string, error: unknown) => void
}

export interface DashboardSnapshotRefresher {
  refresh: (options: DashboardSnapshotRefreshOptions) => Promise<void>
}

/**
 * 业务读取失败是快照协调的预期路径（单路失败保旧），只在控制台记录
 * 非请求类异常；取消来自测试或 Query 客户端销毁，也不应当成页面错误。
 */
const isExpectedSnapshotFailure = (error: unknown): boolean => (
  error instanceof ApiRequestError
  || (error instanceof Error && (error.name === 'CancelledError' || error.name === 'AbortError'))
)

const errorMessageOf = (error: unknown): string => (
  error instanceof Error ? error.message : '加载 Dashboard 数据失败'
)

export function createDashboardSnapshotRefresher(
  dependencies: DashboardSnapshotRefresherDependencies,
): DashboardSnapshotRefresher {
  let inFlight: Promise<void> | null = null

  const refresh = (options: DashboardSnapshotRefreshOptions): Promise<void> => {
    if (inFlight) {
      return options.force
        ? inFlight.then(() => refresh({ ...options, force: false }))
        : inFlight
    }

    const attemptedAt = dependencies.now()
    dependencies.store.startRefresh()

    const request = (async () => {
      let snapshot: DashboardBusinessSnapshot | undefined
      let refreshError: string | undefined
      try {
        if (!dependencies.isOnline()) {
          refreshError = '当前处于离线状态'
          return
        }

        const [, snapshotResult] = await Promise.allSettled([
          Promise.resolve().then(() => dependencies.probeBackend()),
          Promise.resolve().then(() => dependencies.readSnapshot(options.client)),
        ])

        if (snapshotResult.status === 'fulfilled') {
          snapshot = snapshotResult.value
        } else {
          refreshError = errorMessageOf(snapshotResult.reason)
          if (!isExpectedSnapshotFailure(snapshotResult.reason)) {
            dependencies.logError('加载 Dashboard 数据失败:', snapshotResult.reason)
          }
        }
      } catch (error) {
        refreshError = errorMessageOf(error)
        dependencies.logError('加载 Dashboard 数据失败:', error)
      } finally {
        dependencies.store.finishRefresh(attemptedAt, snapshot, snapshot ? undefined : refreshError)
      }
    })()

    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null
    })
    inFlight = tracked
    return tracked
  }

  return { refresh }
}

export const dashboardSnapshotRefresher = createDashboardSnapshotRefresher({
  store: {
    startRefresh: () => useDashboardStore.getState().startRefresh(),
    finishRefresh: (attemptedAt, snapshot, error) => {
      useDashboardStore.getState().finishRefresh(attemptedAt, snapshot, error)
    },
  },
  readSnapshot: client => client.fetchQuery(dashboardSnapshotQueryOptions()),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
  probeBackend: () => probeBackendAvailability({
    showChecking: useStatusStore.getState().backendStatus !== 'available',
  }),
  now: () => Date.now(),
  logError: (message, error) => console.error(message, error),
})
