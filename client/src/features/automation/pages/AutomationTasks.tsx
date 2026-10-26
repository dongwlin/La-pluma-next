/**
 * 日常任务页
 *
 * 页面只组合页头、全局状态指示与自动化工作区；配置草稿、Run 执行订阅、
 * 流程/定时/摘要面板、任务编辑与连接测试分别由工作区和领域所有者持有。
 * 页面不调用领域 API、不读写存储、不轮询，也不维护第二套流程控制。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import AutomationWorkspace from '../components/AutomationWorkspace'

export default function AutomationTasks() {
  return (
    <div className="app-page ios-workspace-page" data-automation-tasks>
      <div className="app-stack-section">
        <PageHeader
          title="日常任务"
          subtitle="安排日常流程，一键执行或定时运行"
          mobileLayout="inline"
          actions={<FloatingStatusIndicator />}
        />

        <AutomationWorkspace />
      </div>
    </div>
  )
}
