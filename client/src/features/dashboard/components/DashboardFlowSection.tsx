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
