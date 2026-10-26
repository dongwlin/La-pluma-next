/**
 * 自动战斗单一作业卡
 *
 * 组合设置、输入/识别方式、作业集预览与搜索/信息三栏。配置草稿、预览
 * 会话、选择与执行投影都由工作区提供；本地输入状态由各面板订阅自己的
 * 会话存储，不推动无关列表重渲染。
 */

import { Card } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CombatTask } from '../types'
import CombatCopilotInfoPanel from './CombatCopilotInfoPanel'
import CombatCopilotInputPanel from './CombatCopilotInputPanel'
import CombatCopilotSetPanel from './CombatCopilotSetPanel'
import CombatSearchPanel from './CombatSearchPanel'
import CombatSettingsPanel from './CombatSettingsPanel'
import CombatTaskHeading from './CombatTaskHeading'
import type {
  CombatCopilotConfig,
  CombatCopilotExecutionActions,
  CombatCopilotPreviewProjection,
  CombatCopilotSearchProjection,
  CombatCopilotSelectionProjection,
} from './combatPanelTypes'

interface CombatCopilotTaskPanelProps {
  task: CombatTask
  config: CombatCopilotConfig
  preview: CombatCopilotPreviewProjection
  view: CopilotSetView
  selection: CombatCopilotSelectionProjection
  search: CombatCopilotSearchProjection
  execution: CombatCopilotExecutionActions
}

export default function CombatCopilotTaskPanel({
  task,
  config,
  preview,
  view,
  selection,
  search,
  execution,
}: CombatCopilotTaskPanelProps) {
  return (
    <Card
      smoothCorners
      className="combat-task-card p-0!"
    >
      <CombatTaskHeading
        task={task}
        buttonClassName="combat-task-run-button min-h-11 px-4 text-sm sm:px-6"
        automationAvailable={execution.automationAvailable}
        unavailableMessage={execution.unavailableMessage}
        isRunning={execution.isRunning}
        isStopping={execution.isStopping}
        isSubmitting={execution.isSubmitting}
        onExecute={execution.onExecute}
        onStop={execution.onStop}
      />

      {/* 作业配置区 */}
      <div className="combat-copilot-layout">
        {/* 左栏：设置项 */}
        <div className="space-y-3 xl:sticky xl:top-4">
          <CombatSettingsPanel
            task={task}
            formationMode={config.formationMode}
            raid={config.raid}
            setExecutionMode={config.setExecutionMode}
            advanced={config.advanced}
            onFormationChange={config.onFormationChange}
            onRaidChange={value => config.onAdvancedChange('raid', value)}
            onSetExecutionModeChange={config.onSetExecutionModeChange}
            onAdvancedChange={config.onAdvancedChange}
          />
        </div>

        {/* 中栏：输入框 + 作业列表 */}
        <div className="flex min-w-0 flex-col space-y-3">
          <CombatCopilotInputPanel
            input={config.input}
            isLoading={preview.loading}
            previewModeStore={preview.modeStore}
            onInputChange={config.onInputChange}
            onPreview={preview.onPreview}
            onCancelPreview={preview.onCancel}
          />

          <CombatCopilotSetPanel
            preview={preview.info}
            view={view}
            selected={selection.selected}
            isRunning={execution.isRunning}
            isResetting={selection.isResetting}
            isContinuing={execution.isContinuing}
            automationAvailable={execution.automationAvailable}
            unavailableMessage={execution.unavailableMessage}
            onToggle={selection.onToggle}
            onToggleAll={selection.onToggleAll}
            onOpenReset={selection.onOpenReset}
            onStartNext={execution.onStartNext}
            onCancelSet={execution.onCancelSet}
          />
        </div>

        {/* 右栏：搜索框 + 作业介绍 */}
        <div className="space-y-3 xl:sticky xl:top-4">
          <CombatSearchPanel {...search} />
          <CombatCopilotInfoPanel
            preview={preview.info}
            view={view}
            isRunning={execution.isRunning}
            onClear={preview.onClear}
          />
        </div>
      </div>
    </Card>
  )
}
