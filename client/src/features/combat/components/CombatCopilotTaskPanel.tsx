import { Card } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CombatTask } from '../types'
import CombatCopilotSetPanel from './CombatCopilotSetPanel'
import CombatCopilotSourceBar from './CombatCopilotSourceBar'
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
        isWaitingForNext={execution.isWaitingForNext}
        isContinuing={execution.isContinuing}
        onExecute={execution.onExecute}
        onStop={execution.onStop}
        onStartNext={execution.onStartNext}
      />

      <CombatCopilotSourceBar
        input={config.input}
        isLoading={preview.loading}
        hasPreview={preview.info !== null}
        previewModeStore={preview.modeStore}
        search={search}
        onInputChange={config.onInputChange}
        onPreview={preview.onPreview}
        onCancelPreview={preview.onCancel}
        onClear={preview.onClear}
      />

      <div className="combat-copilot-body">
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

        <div className="combat-copilot-params">
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
      </div>
    </Card>
  )
}
