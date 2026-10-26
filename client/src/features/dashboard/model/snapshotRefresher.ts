/**
 * 总览完整快照刷新协调器
 *
 * 职责边界：
 * - 完整业务快照由本协调器单飞刷新；五路全部有效才调用
 *   `dashboardStore.finishRefresh` 原子提交，单路失败只更新尝试时间。
 * - 后端探针与其他五路并发，但它的失败不否决已成功的业务快照；
 *   探针自身有 revision 处理，可能被应用级监测取代。
 * - 设备采样不在本模块内，由 device-mirror 的轮询入口独立持有。
 *
 * `force` 与既有行为一致：若已有刷新在途，先等它结束再补一次，避免
 * 失效发生在读取过程中时丢失。协调器不因页面 Activity 隐藏而中止读取，
 * 结果仍写入 store；页面只负责停止自己的计时器。
 */

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
  finishRefresh: (attemptedAt: number, snapshot?: DashboardBusinessSnapshot) => void
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
      try {
        if (!dependencies.isOnline()) return

        const [, snapshotResult] = await Promise.allSettled([
          Promise.resolve().then(() => dependencies.probeBackend()),
          Promise.resolve().then(() => dependencies.readSnapshot(options.client)),
        ])

        if (snapshotResult.status === 'fulfilled') {
          snapshot = snapshotResult.value
        } else if (!isExpectedSnapshotFailure(snapshotResult.reason)) {
          dependencies.logError('加载 Dashboard 数据失败:', snapshotResult.reason)
        }
      } catch (error) {
        dependencies.logError('加载 Dashboard 数据失败:', error)
      } finally {
        dependencies.store.finishRefresh(attemptedAt, snapshot)
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
    finishRefresh: (attemptedAt, snapshot) => {
      useDashboardStore.getState().finishRefresh(attemptedAt, snapshot)
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
