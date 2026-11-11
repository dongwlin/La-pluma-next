/**
 * 作业面板的共享 props 契约
 *
 * 搜索词与识别方式通过会话存储传递，工作区不订阅，避免输入推动大列表重渲染。
 */

import type {
  AdvancedValues,
} from '../model/combatCommands'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import type { CopilotQueueRunProjection } from '../model/copilotQueueRun'
import type { CopilotSetItemStatus } from '../model/copilotSetRun'
import type { CopilotQueueEntry, CopilotQueueMoveDirection } from '../model/copilotQueue'
import type { CopilotQueueFailurePolicy } from '../api'
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

/** 作业集卡片额外暴露下一关；服务端持有等待态。 */
export interface CombatCopilotExecutionActions extends CombatExecutionActions {
  isWaitingForNext: boolean
  onStartNext: () => void
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

export type CombatCopilotDetailSelection = { type: 'preview' } | { type: 'queue'; id: string }

export const COPILOT_DETAIL_LAYER_ID = 'combat-copilot-detail-panel'

export interface CombatCopilotFileImportProjection {
  isImporting: boolean
  onImport: (file: File) => void
}

export interface CombatCopilotSelectionProjection {
  isResetting: boolean
  onOpenReset: () => void
}

export interface CombatCopilotQueueProjection {
  entries: readonly CopilotQueueEntry[]
  selected: ReadonlySet<string>
  setId: string | null
  itemStatuses: ReadonlyMap<number, CopilotSetItemStatus>
  itemErrors: ReadonlyMap<number, string>
  submittedEntryIds: ReadonlySet<string>
  queueRun: CopilotQueueRunProjection | null
  failurePolicy: CopilotQueueFailurePolicy
  isRunning: boolean
  isSubmitting: boolean
  isContinuing: boolean
  isSkipping: boolean
  isAdding: boolean
  addingUri: string | null
  automationAvailable: boolean
  unavailableMessage: string
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, direction: CopilotQueueMoveDirection) => void
  onClear: () => void
  onAddCurrent: () => void
  onAddUri: (uri: string) => void
  onContinueQueue: () => void
  onSkipEntry: () => void
  onRetryFailed: () => void
}

export interface CombatCopilotSearchProjection {
  stageStore: PanelStateStore<string>
  selectionStore: PanelStateStore<string>
  result: CopilotSearchResult | null
  searching: boolean
  addingUri: string | null
  onSearch: (term: string) => void
  onCancel: () => void
  onSelectUri: (uri: string) => void
  onAddToQueue: (uri: string) => void
}

export interface CombatParadoxSearchProjection {
  nameStore: PanelStateStore<string>
  result: ParadoxSearchResult | null
  searching: boolean
  onSearch: (name: string) => void
  onCancel: () => void
  onSelectUri: (uri: string) => void
}
