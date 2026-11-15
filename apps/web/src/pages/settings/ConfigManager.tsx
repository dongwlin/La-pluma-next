import { PageHeader } from '@/shared/components'
import { SettingsWorkspace } from '@/features/settings'

export default function ConfigManager() {
  return (
    <div className="app-page ios-workspace-page ios-borderless-cards" data-page="config">
      <div className="app-stack-section">
        <PageHeader
          title="配置"
          subtitle="连接设备、管理运行选项与组件更新"
          mobileLayout="inline"
        />

        <SettingsWorkspace />
      </div>
    </div>
  )
}
