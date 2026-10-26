/**
 * 总览工作区
 *
 * 页面唯一的总览领域容器：连接提示、今日流程、设备状态与摘要区域在这里
 * 组合；导航回调只创建一份。
 *
 * - 完整快照刷新由页面持有的 `useDashboardSnapshotRefresh` 传入，工作区
 *   不再创建第二个计时器或失效订阅；
 * - 设备采样投影在这里调用一次，采样本身仍由 device-mirror 的 Query 持有；
 * - 各区域只订阅自己使用的 store 切片或 runtime-status 投影，设备样本、
 *   摘要或连接状态变化不会推动无关区域重渲染。
 */

import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { appTabRoute } from '@/shared/navigation'
import { useDashboardDeviceStats } from '../hooks/useDashboardDeviceStats'
import DashboardConnectionAlert from './DashboardConnectionAlert'
import DashboardDeviceSection from './DashboardDeviceSection'
import DashboardFlowSection from './DashboardFlowSection'
import DashboardSummarySection from './DashboardSummarySection'

interface DashboardWorkspaceProps {
  refreshDashboard: () => Promise<void>
}

export default function DashboardWorkspace({ refreshDashboard }: DashboardWorkspaceProps) {
  const navigate = useNavigate()
  useDashboardDeviceStats()

  const openAutomation = useCallback(() => navigate(appTabRoute('automation')), [navigate])
  const openTraining = useCallback(() => navigate(appTabRoute('training')), [navigate])
  const openStatistics = useCallback(() => navigate(appTabRoute('statistics')), [navigate])

  return (
    <>
      <DashboardConnectionAlert refreshDashboard={refreshDashboard} />
      <DashboardFlowSection refreshDashboard={refreshDashboard} onOpenAutomation={openAutomation} />
      <DashboardDeviceSection />
      <DashboardSummarySection onOpenTraining={openTraining} onOpenStatistics={openStatistics} />
    </>
  )
}
