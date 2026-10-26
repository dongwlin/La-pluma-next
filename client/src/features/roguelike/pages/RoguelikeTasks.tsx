/**
 * 肉鸽任务页
 *
 * 页面只组合页头、工作区与预览；配置草稿、执行订阅、模式与字段状态分别由
 * 工作区容器和领域所有者持有。
 */

import { PageHeader } from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import RoguelikeWorkspace from '../components/RoguelikeWorkspace'

export default function RoguelikeTasks() {
  return (
    <div className="app-page ios-workspace-page roguelike-page" data-workbench-tasks>
      <div className="app-stack-section">
        <PageHeader
          title="肉鸽模式"
          subtitle="集成战略与生息演算配置"
          mobileLayout="inline"
          actions={(
            <FloatingStatusIndicator
              className="w-full overflow-hidden sm:w-auto"
              textClassName="truncate whitespace-nowrap"
            />
          )}
        />

        <RoguelikeWorkspace />
      </div>
    </div>
  )
}
