import type {
  AdvancedValues,
} from '../model/combatCommands'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import type { PanelStateStore } from '../model/panelState'
import type {
  CopilotRaid,
  CopilotSearchResult,
  CopilotSetExecutionMode,
  CopilotSetInfo,
  FormationMode,
  ParadoxSearchResult,
} from '../types'

export interface CombatExecutionActions {
  automationAvailable: boolean
  unavailableMessage: string
  isRunning: boolean
  isStopping: boolean
  isSubmitting: boolean
  isContinuing: boolean
  onExecute: () => void
  onStop: () => void
}

/** 作业集卡片额外暴露下一关与取消等待；服务端持有等待态。 */
export interface CombatCopilotExecutionActions extends CombatExecutionActions {
  onStartNext: () => void
  onCancelSet: () => void
}

export interface CombatCopilotConfig {
  input: string
  advanced: AdvancedValues
  formationMode: FormationMode
  raid: CopilotRaid
  setExecutionMode: CopilotSetExecutionMode
  onInputChange: (value: string) => void
  onAdvancedChange: (key: string, value: string | number | boolean) => void
  onFormationChange: (mode: FormationMode) => void
  onSetExecutionModeChange: (mode: CopilotSetExecutionMode) => void
}

export interface CombatCopilotPreviewProjection {
  info: CopilotSetInfo | null
  loading: boolean
  modeStore: PanelStateStore<CopilotPreviewMode>
  onPreview: () => void
  onCancel: () => void
  onClear: () => void
}

export interface CombatCopilotSelectionProjection {
  selected: ReadonlySet<number>
  isResetting: boolean
  onToggle: (index: number) => void
  onToggleAll: () => void
  onOpenReset: () => void
}

export interface CombatCopilotSearchProjection {
  stageStore: PanelStateStore<string>
  selectionStore: PanelStateStore<string>
  result: CopilotSearchResult | null
  searching: boolean
  onSearch: (term: string) => void
  onCancel: () => void
  onSelectUri: (uri: string) => void
}

export interface CombatParadoxSearchProjection {
  nameStore: PanelStateStore<string>
  result: ParadoxSearchResult | null
  searching: boolean
  onSearch: (name: string) => void
  onCancel: () => void
  onSelectUri: (uri: string) => void
}
