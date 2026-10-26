/**
 * 数据统计页
 *
 * 页面只组合页头、全局状态指示与统计工作区；四类读取、识别/材料命令投影、
 * tab 与各面板局部状态分别由 `StatisticsWorkspace` 和面板持有，页面不直接
 * 访问 API、Query、命令所有者或 localStorage。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import StatisticsWorkspace from '../components/StatisticsWorkspace'

export default function DataStatistics() {
  return (
    <div className="app-page ios-workspace-page ios-borderless-cards data-statistics-page">
      <div className="app-stack-section">
        {/* 页面标题 */}
        <PageHeader
          title="数据"
          subtitle="识别并查看仓库、干员与掉落数据"
          mobileLayout="inline"
          actions={(
            <div className="data-statistics-status min-w-0 max-w-full">
              <FloatingStatusIndicator
                className="max-w-full"
                textClassName="truncate whitespace-nowrap"
              />
            </div>
          )}
        />

        <StatisticsWorkspace />
      </div>
    </div>
  )
}
