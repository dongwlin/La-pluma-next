/**
 * 控制台总览页
 *
 * 页面只负责首屏门禁与页头：未加载时展示完整骨架；加载后组合总览工作区，
 * 并持有唯一的完整快照刷新调度。连接提示、今日流程、设备状态与摘要分别
 * 由工作区和区域面板持有，页面不调用执行/采样 hook、不导航、不读写存储。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import { DashboardSkeleton } from '@/features/dashboard'
import { DashboardWorkspace } from '@/features/dashboard'
import { useDashboardSnapshotRefresh } from '@/features/dashboard'
import { useDashboardStore } from '@/features/dashboard'

export default function Dashboard() {
  const hasLoaded = useDashboardStore(state => state.hasLoaded)
  const { refreshDashboard } = useDashboardSnapshotRefresh()

  if (!hasLoaded) {
    return <DashboardSkeleton />
  }

  return (
    <div className="app-page dashboard-page" data-page="dashboard">
      <div className="app-stack-section">
        <PageHeader
          title="概览"
          subtitle="当前活动、自动化进度、养成与掉落总览"
          mobileLayout="inline"
          actions={
            <div className="dashboard-page-actions flex w-full items-center sm:w-auto">
              <div className="dashboard-status-slot min-w-0 flex-1 sm:flex-none">
                <FloatingStatusIndicator className="dashboard-status-indicator w-full sm:w-auto" textClassName="truncate whitespace-nowrap" />
              </div>
            </div>
          }
        />

        <DashboardWorkspace refreshDashboard={refreshDashboard} />
      </div>
    </div>
  )
}
