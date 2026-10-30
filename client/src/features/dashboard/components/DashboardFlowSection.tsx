/**
 * 总览流程区域
 *
 * 流程卡与模拟器预览共享同一网格：`useDashboardFlowLayout` 的列宽测量
 * 需要同时观察网格、流程卡与预览壳。预览入口仍由 device-mirror 的会话
 * 持有，不因流程加载或快照刷新而卸载。
 */

import DashboardPreviewEntry from './DashboardPreviewEntry'
import DashboardFlowPanel from './DashboardFlowPanel'
import { useDashboardFlowLayout } from '../hooks/useDashboardFlowLayout'

interface DashboardFlowSectionProps {
  refreshDashboard: () => Promise<void>
  onOpenAutomation: () => void
}

export default function DashboardFlowSection({ refreshDashboard, onOpenAutomation }: DashboardFlowSectionProps) {
  const { flowGridRef, flowCardRef, flowPreviewRef, flowGridStyle } = useDashboardFlowLayout()

  return (
    <div ref={flowGridRef} className="dashboard-flow-layout" style={flowGridStyle}>
      <div ref={flowCardRef} className="min-w-0">
        <DashboardFlowPanel refreshDashboard={refreshDashboard} onMissingFlow={onOpenAutomation} />
      </div>

      <div ref={flowPreviewRef} className="min-w-0">
        <DashboardPreviewEntry />
      </div>
    </div>
  )
}
