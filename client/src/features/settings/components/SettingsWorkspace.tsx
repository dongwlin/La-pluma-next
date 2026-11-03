import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import { useConfigSection } from '../hooks/useConfigSection'
import { useDeviceConnectionActivityCleanup } from '../hooks/useSettingsDeviceConnection'
import { isEditableConfigSection } from '../model/configSection'
import ConfigDirectoryPanel from './ConfigDirectoryPanel'
import ConfigSectionNav from './ConfigSectionNav'
import ConnectionConfigPanel from './ConnectionConfigPanel'
import ReadOnlyConfigPanel from './ReadOnlyConfigPanel'
import SettingsUpdatesPanel from './SettingsUpdatesPanel'

export default function SettingsWorkspace() {
  const { section, selectSection } = useConfigSection()
  // connection 表单始终挂载；能力模型决定当前 section 是否渲染可写表单。
  const connectionEditable = isEditableConfigSection(section)
  useDeviceConnectionActivityCleanup()

  return (
    <>
      <PageHeader
        title="配置"
        subtitle="连接设备、管理运行选项与组件更新"
        mobileLayout="inline"
        actions={(
          <FloatingStatusIndicator
            className="w-full overflow-hidden sm:w-auto"
            textClassName="truncate whitespace-nowrap"
          />
        )}
      />

      <ConfigSectionNav section={section} onSelect={selectSection} />

      <div className="config-workspace-grid grid min-w-0 gap-(--app-space-section) xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] xl:items-start">
        <div className="config-workspace-primary app-stack-section min-w-0">
          <ConnectionConfigPanel isActive={connectionEditable} />
          {connectionEditable ? null : <ReadOnlyConfigPanel section={section} />}
          <ConfigDirectoryPanel />
        </div>

        <div className="config-workspace-secondary app-stack-section min-w-0">
          <SettingsUpdatesPanel />
        </div>
      </div>
    </>
  )
}
