import DashboardDropSummaryCard from './DashboardDropSummaryCard'
import DashboardTrainingSummaryCard from './DashboardTrainingSummaryCard'

interface DashboardSummarySectionProps {
  onOpenTraining: () => void
  onOpenStatistics: () => void
}

export default function DashboardSummarySection({ onOpenTraining, onOpenStatistics }: DashboardSummarySectionProps) {
  return (
    <div className="dashboard-summary-grid">
      <DashboardTrainingSummaryCard onOpenTraining={onOpenTraining} />
      <DashboardDropSummaryCard onOpenStatistics={onOpenStatistics} />
    </div>
  )
}
