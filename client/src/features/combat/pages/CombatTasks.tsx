/**
 * 自动战斗页
 *
 * 页面只组合页头、全局状态指示与作业工作区；配置草稿、预览/搜索请求、
 * 执行订阅、作业集选择与面板局部输入分别由工作区和领域所有者持有。
 * 页面不调用搜索/预览/执行 hook，也不持有请求生命周期。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import CombatWorkspace from '../components/CombatWorkspace'

export default function CombatTasks() {
  return (
    <div className="app-page combat-page ios-workspace-page" data-workbench-tasks>
      <div className="app-stack-section">
        <PageHeader
          title="自动战斗"
          subtitle="支持单作业、作业集、保全派驻、悖论模拟与链接识别"
          mobileLayout="inline"
          actions={<FloatingStatusIndicator />}
        />

        <CombatWorkspace />
      </div>
    </div>
  )
}
