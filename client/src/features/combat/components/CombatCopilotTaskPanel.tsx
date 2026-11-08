import { Card } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CombatTask } from '../types'
import CombatCopilotQueuePanel from './CombatCopilotQueuePanel'
import CombatCopilotSetPanel from './CombatCopilotSetPanel'
import CombatCopilotSourceBar from './CombatCopilotSourceBar'
import CombatSettingsPanel from './CombatSettingsPanel'
import CombatTaskHeading from './CombatTaskHeading'
import type {
  CombatCopilotConfig,
  CombatCopilotExecutionActions,
  CombatCopilotFileImportProjection,
  CombatCopilotPreviewProjection,
  CombatCopilotQueueProjection,
  CombatCopilotSearchProjection,
  CombatCopilotSelectionProjection,
} from './combatPanelTypes'

interface CombatCopilotTaskPanelProps {
  task: CombatTask
  config: CombatCopilotConfig
  preview: CombatCopilotPreviewProjection
  fileImport: CombatCopilotFileImportProjection
  view: CopilotSetView
  selection: CombatCopilotSelectionProjection
  queue: CombatCopilotQueueProjection
  search: CombatCopilotSearchProjection
  execution: CombatCopilotExecutionActions
}

export default function CombatCopilotTaskPanel({
  task,
  config,
  preview,
  fileImport,
  view,
  selection,
  queue,
  search,
  execution,
}: CombatCopilotTaskPanelProps) {
  const previewInfo = preview.info

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
        isAddingToQueue={queue.isAdding}
        previewModeStore={preview.modeStore}
        search={search}
        fileImport={fileImport}
        onInputChange={config.onInputChange}
        onPreview={preview.onPreview}
        onAddToQueue={queue.onAddCurrent}
        onCancelPreview={preview.onCancel}
        onClear={preview.onClear}
      />

      <div className="combat-copilot-body">
        <div className="combat-copilot-queue-column">
          <CombatCopilotQueuePanel queue={queue} />

          {previewInfo !== null && (
            <CombatCopilotSetPanel
              preview={previewInfo}
              view={view}
              isRunning={execution.isRunning}
              isResetting={selection.isResetting}
              isContinuing={execution.isContinuing}
              onOpenReset={selection.onOpenReset}
              onStartNext={execution.onStartNext}
              onCancelSet={execution.onCancelSet}
            />
          )}
        </div>

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
