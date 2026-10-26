/**
 * 总览摘要区域
 *
 * 养成与掉落各自订阅自己的摘要切片，任一摘要更新不推动另一张卡重渲染；
 * 导航回调由工作区统一提供。
 */

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
