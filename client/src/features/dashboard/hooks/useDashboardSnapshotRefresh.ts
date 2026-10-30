/**
 * 总览完整快照的页面同步入口
 *
 * 页面不再自己组织请求、探针与失效订阅：
 * - 首屏/周期刷新按 `lastRefreshAttemptAt` 与 5 分钟间隔调度；恢复的 v1
 *   活动摘要缺少 `status` 时立即补一次刷新；
 * - 收到 `dashboard-snapshot` 失效（计划应用、识别、资源更新等发布端）
 *   时强制刷新；Activity 隐藏期间错过的发布在恢复时由失效 hook 补发；
 * - 网络恢复时强制刷新；
 * - Activity 隐藏会清理本 hook 的计时器与失效订阅，恢复时重建且只保留
 *   一个计时器；在途协调读取不因隐藏中止。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePageVisible } from '@/shared/hooks/usePageVisible'
import { useOnlineStatus } from '@/shared/hooks/useOnlineStatus'
import { useResourceInvalidation } from '@/features/resource-invalidation'
import { DASHBOARD_REFRESH_INTERVAL_MS } from '../constants'
import { dashboardSnapshotRefresher } from '../model/snapshotRefresher'
import { useDashboardStore } from '../store/dashboardStore'

const DASHBOARD_RESOURCE_SCOPES = ['dashboard-snapshot'] as const

export function useDashboardSnapshotRefresh() {
  const client = useQueryClient()
  const isOnline = useOnlineStatus()
  const visible = usePageVisible()
  const wasOnlineRef = useRef(isOnline)
  const wasVisibleRef = useRef(visible)

  const refreshDashboard = useCallback(
    () => dashboardSnapshotRefresher.refresh({ client, force: true }),
    [client],
  )

  useResourceInvalidation(DASHBOARD_RESOURCE_SCOPES, () => {
    // 文档隐藏时不发起读取；恢复可见时下面的 Effect 会补一次刷新。
    if (!visible) return
    void dashboardSnapshotRefresher.refresh({ client, force: true })
  })

  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false
      return
    }
    const resumed = wasVisibleRef.current === false
    wasVisibleRef.current = true
    let disposed = false
    let timer: number | null = null

    const scheduleNextRefresh = () => {
      if (disposed) return
      const lastAttempt = useDashboardStore.getState().lastRefreshAttemptAt
      const elapsed = lastAttempt === null ? DASHBOARD_REFRESH_INTERVAL_MS : Date.now() - lastAttempt
      const delay = Math.max(1000, DASHBOARD_REFRESH_INTERVAL_MS - elapsed)
      timer = window.setTimeout(() => {
        void dashboardSnapshotRefresher.refresh({ client }).finally(scheduleNextRefresh)
      }, delay)
    }
    const refreshThenSchedule = () => {
      void dashboardSnapshotRefresher.refresh({ client }).finally(scheduleNextRefresh)
    }
    const cache = useDashboardStore.getState()
    const cacheIsStale = cache.lastRefreshAttemptAt === null
      || Date.now() - cache.lastRefreshAttemptAt >= DASHBOARD_REFRESH_INTERVAL_MS
    // v1 缓存没有活动状态字段：挂载时立即补一次刷新，避免卡片长期停在刷新中。
    const activityStatusMissing = cache.activitySummary.status === undefined

    // 从隐藏恢复时立即刷新，补上隐藏期间错过的周期与失效事件。
    if (resumed || !cache.hasLoaded || cacheIsStale || activityStatusMissing) refreshThenSchedule()
    else scheduleNextRefresh()

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [client, visible])

  useEffect(() => {
    if (visible && isOnline && !wasOnlineRef.current) {
      void dashboardSnapshotRefresher.refresh({ client, force: true })
    }
    wasOnlineRef.current = isOnline
  }, [client, isOnline, visible])

  return { refreshDashboard }
}
