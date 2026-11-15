import { PageHeader } from '@/shared/components'
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
        />

        <DashboardWorkspace refreshDashboard={refreshDashboard} />
      </div>
    </div>
  )
}
