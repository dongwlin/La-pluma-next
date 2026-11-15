import { PageHeader } from '@/shared/components'
import { RoguelikeWorkspace } from '@/features/roguelike'

export default function RoguelikeTasks() {
  return (
    <div className="app-page ios-workspace-page roguelike-page" data-workbench-tasks data-page="roguelike">
      <div className="app-stack-section">
        <PageHeader
          title="肉鸽模式"
          subtitle="集成战略与生息演算配置"
          mobileLayout="inline"
        />

        <RoguelikeWorkspace />
      </div>
    </div>
  )
}
