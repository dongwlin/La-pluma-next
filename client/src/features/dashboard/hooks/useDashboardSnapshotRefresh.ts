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
