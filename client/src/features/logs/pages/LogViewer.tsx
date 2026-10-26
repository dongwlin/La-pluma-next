/**
 * 日志页
 *
 * 页面只组合页头、全局状态指示与日志工作区；实时/历史会话、过滤视图、
 * 自滚动、命令与确认弹层分别由工作区和面板持有。页面不访问日志 API、
 * 不持有请求生命周期，也不直接操作历史选择。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import LogsWorkspace from '../components/LogsWorkspace'

export default function LogViewer() {
  return (
    <div className="app-page log-viewer ios-workspace-page ios-borderless-cards">
      <div className="app-stack-section">
        <PageHeader
          title="日志"
          subtitle="实时查看任务执行与历史记录"
          mobileLayout="inline"
          actions={<FloatingStatusIndicator />}
        />

        <LogsWorkspace />
      </div>
    </div>
  )
}
