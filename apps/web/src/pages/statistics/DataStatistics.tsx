import { PageHeader } from '@/shared/components'
import { StatisticsWorkspace } from '@/features/statistics'
import { DeviceMonitorLayout } from '@/features/device-mirror'

export default function DataStatistics() {
  return (
    <div className="app-page ios-workspace-page ios-borderless-cards data-statistics-page" data-page="statistics">
      <div className="app-stack-section">
        <PageHeader
          title="数据"
          subtitle="识别并查看仓库、干员与掉落数据"
          mobileLayout="inline"
        />

        <DeviceMonitorLayout>
          <StatisticsWorkspace />
        </DeviceMonitorLayout>
      </div>
    </div>
  )
}
