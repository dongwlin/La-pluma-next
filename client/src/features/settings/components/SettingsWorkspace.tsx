/**
 * 设置工作区容器
 *
 * 跨面板的页面级状态只有 section：存储、window 事件与切换由
 * `useConfigSection` 持有。各面板各自订阅所属领域所有者/Query：
 * - 连接面板始终挂载（非 connection section 返回 null），section 切换不重建
 *   草稿读取，也不清空保存/读取反馈；
 * - 设备发现/连接测试只在设备面板订阅，更新、自动更新与版本只在更新面板；
 * - 配置目录卡片与只读 section 头部订阅同一目录 Query，不重复请求。
 *
 * 设备命令的取消仍跟随页面/Activity 生命周期：工作区在 Effect cleanup 中
 * 调用 `cancelAll()`，section 切换不中断在途查找/测试。
 */

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
