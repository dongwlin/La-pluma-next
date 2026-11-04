import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getErrorMessage } from '@/shared/api'
import { Button, ConfirmDialog } from '@/shared/ui'
import { useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { DeviceMonitorPanel } from '@/features/device-mirror'
import { isTerminalRunState } from '@/features/task-execution'
import { useUserConfig } from '@/features/user-config'
import { resetCopilotSetProgress as resetCopilotSetProgressRequest } from '../api'
import { useCombatExecution } from '../hooks/useCombatExecution'
import { useCopilotPreview } from '../hooks/useCopilotPreview'
import { useCopilotSearch, useParadoxSearch } from '../hooks/useCopilotSearch'
import {
  combatConfigAdapter,
  createDefaultCombatDraft,
  normalizeRaidValue,
} from '../model/combatConfig'
import type { CombatConfigDraft } from '../model/combatConfig'
import {
  buildCombatCommandArgs,
  buildCopilotSetExecutionOptions,
  normalizeFormationMode,
  toCopilotSetRunMode,
  validateCombatInput,
} from '../model/combatCommands'
import {
  restorableCopilotIndexes,
  selectedCopilotItemIndexes,
  serializeCopilotSelection,
  toggleAllCopilotSelection,
  toggleCopilotSelection,
} from '../model/copilotSelection'
import { deriveCopilotSetView } from '../model/copilotSetView'
import { deriveExecutionProgress } from '../model/executionProgress'
import { createPanelStateStore } from '../model/panelState'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import { invalidateCopilotSetPlan } from '../model/queries'
import { normalizeCopilotInput, parseCopilotUri, splitCopilotInputToArgs } from '../utils/copilotUri'
import type {
  CombatMode,
  CombatTask,
  CopilotSetExecutionMode,
  CopilotSetItem,
  FormationMode,
} from '../types'
import CombatCopilotTaskPanel from './CombatCopilotTaskPanel'
import CombatExecutionProgressPanel from './CombatExecutionProgressPanel'
import CombatModeTabs from './CombatModeTabs'
import CombatSpecialTaskPanel from './CombatSpecialTaskPanel'
import { getCombatTask } from './CombatTaskCatalog'
import type {
  CombatCopilotConfig,
  CombatCopilotExecutionActions,
  CombatCopilotSearchProjection,
  CombatCopilotSelectionProjection,
  CombatExecutionActions,
  CombatParadoxSearchProjection,
} from './combatPanelTypes'

/** 协调器加载完成前的渲染默认值；与迁移前的初始 state 一致。 */
const DEFAULT_COMBAT_CONFIG = createDefaultCombatDraft()

export default function CombatWorkspace() {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const { isAvailable: automationAvailable, unavailableMessage } = useAutomationAvailability()
  const {
    draft: configDraft,
    syncState: configSyncState,
    error: configSyncError,
    update: updateConfig,
    channel: configChannel,
    retry: retryConfigSave,
  } = useUserConfig(combatConfigAdapter)
  const {
    taskInputs,
    advancedParams,
    autoFormation,
    copilotSetExecutionMode,
    copilotSetSelections,
  } = configDraft ?? DEFAULT_COMBAT_CONFIG
  const isRetryingConfigSave = configSyncState === 'saving'
  const queryClient = useQueryClient()
  const {
    preview,
    isLoading: isLoadingSet,
    load: loadCopilotPreview,
    refreshSet: refreshCopilotSet,
    resetProgressView: resetCopilotProgressView,
    cancel: cancelCopilotPreview,
    clear: clearCopilotPreview,
  } = useCopilotPreview()
  const {
    result: copilotSearchResult,
    searching: isSearchingCopilot,
    search: searchCopilotJobs,
    cancel: cancelCopilotSearch,
  } = useCopilotSearch()
  const {
    result: paradoxSearchResult,
    searching: isSearchingParadox,
    search: searchParadoxJobs,
    cancel: cancelParadoxSearch,
  } = useParadoxSearch()
  const [activeCombatMode, setActiveCombatMode] = useState<CombatMode>('copilot')
  const [selectedCopilotIndexes, setSelectedCopilotIndexes] = useState<Set<number>>(new Set())
  const [isResettingProgress, setIsResettingProgress] = useState(false)
  const [resetProgressDialogOpen, setResetProgressDialogOpen] = useState(false)
  const reconciledRunRef = useRef<string | null>(null)
  // 用户重置进度后，旧 run 的逐项结果不再属于当前预览。
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null)
  // 面板局部输入由工作区创建、面板订阅；工作区不订阅，因此输入不推动大列表渲染。
  const [panelStores] = useState(() => ({
    copilotPreviewMode: createPanelStateStore<CopilotPreviewMode>('auto'),
    copilotSearchStage: createPanelStateStore(''),
    copilotSearchSelection: createPanelStateStore(''),
    paradoxSearchName: createPanelStateStore(''),
  }))

  const {
    isRunning,
    isWaitingForNext,
    isAutoStopping,
    isStopping,
    isContinuing,
    isSubmitting,
    setRun,
    run: trackedRun,
    submitTask,
    submitSet,
    continueSet,
    stop,
  } = useCombatExecution({
    notify: setStatusMessage,
    stopOnFailure: advancedParams.copilot?.executionStrategy === 'stop',
  })

  // 配置编辑始终以协调器中的最新草稿为基准，避免同一帧内连续更新互相覆盖。
  const updateCombatConfig = useCallback((update: (current: CombatConfigDraft) => CombatConfigDraft) => {
    updateConfig(update(configChannel.getState().draft ?? DEFAULT_COMBAT_CONFIG))
  }, [configChannel, updateConfig])

  const handleRetryConfigSave = async () => {
    if (isRetryingConfigSave) return
    const saved = await retryConfigSave()
    if (saved) setStatusMessage('自动战斗配置已同步', 'success')
  }

  const getSelectedCopilotIndexes = (): number[] => {
    if (!preview?.copilots?.length) return []
    return selectedCopilotItemIndexes(selectedCopilotIndexes, preview.copilots.length)
  }

  const applySelectedCopilotIndexes = useCallback((indexes: Set<number>, setId: string) => {
    const normalized = serializeCopilotSelection(indexes)
    setSelectedCopilotIndexes(new Set(normalized))
    updateCombatConfig(current => ({
      ...current,
      copilotSetSelections: {
        ...current.copilotSetSelections,
        [setId]: normalized,
      },
    }))
  }, [updateCombatConfig])

  // 服务端计划进度是“待执行”的唯一来源：成功的条目从选择中移除，失败项保留待重试。
  const restoreSelectedCopilots = useCallback((
    setId: string,
    copilots: CopilotSetItem[],
    raid: 'normal' | 'raid' | 'both',
  ) => {
    const indexes = restorableCopilotIndexes(copilots, raid, copilotSetSelections[setId])
    applySelectedCopilotIndexes(new Set(indexes), setId)
  }, [applySelectedCopilotIndexes, copilotSetSelections])

  const resetCopilotSetProgress = async () => {
    if (!preview?.copilots?.length) return false
    if (isResettingProgress) return false

    setIsResettingProgress(true)
    try {
      const result = await resetCopilotSetProgressRequest(preview.id)
      if (!result.success) {
        throw new Error(getErrorMessage(result))
      }
      applySelectedCopilotIndexes(new Set(preview.copilots.map((_, index) => index)), preview.id)
      resetCopilotProgressView(preview.id)
      // 服务端进度已改变：下次预览必须重新读取计划，不能复用旧的 completedModes。
      void invalidateCopilotSetPlan(queryClient, preview.id)
      if (setRun) setDismissedRunId(setRun.runId)
      setStatusMessage('已重置作业集进度，将从第一关开始', 'success')
      return true
    } catch (error) {
      setStatusMessage(`重置失败: ${(error as Error).message}`, 'error')
      return false
    } finally {
      setIsResettingProgress(false)
    }
  }

  const setView = deriveCopilotSetView({
    preview,
    selected: selectedCopilotIndexes,
    setRun,
    dismissedRunId,
    raid: normalizeRaidValue(advancedParams.copilot?.raid),
    isWaitingForNext,
    isAutoStopping,
  })

  const executionProgress = useMemo(
    () => deriveExecutionProgress(trackedRun, setRun),
    [trackedRun, setRun],
  )

  // 终态后按服务端计划进度重建“待执行”选择。成功的条目会被计划标记为已完成，
  // 失败的条目保留待重试；同步失败只影响展示，不把 run 结果解释成完成。
  const activeSetRun = setView.activeSetRun
  useEffect(() => {
    if (!activeSetRun || activeSetRun.isActive) return
    if (!isTerminalRunState(activeSetRun.state)) return
    const setId = activeSetRun.setId
    if (!setId) return
    if (reconciledRunRef.current === activeSetRun.runId) return
    reconciledRunRef.current = activeSetRun.runId

    const raid = normalizeRaidValue(activeSetRun.raid ?? advancedParams.copilot?.raid)
    void (async () => {
      const copilots = await refreshCopilotSet(setId, raid)
      if (!copilots?.length) return
      restoreSelectedCopilots(setId, copilots, raid)
    })()
  }, [activeSetRun, advancedParams.copilot?.raid, refreshCopilotSet, restoreSelectedCopilots])

  const buildCommandArgs = (task: CombatTask): string[] => buildCombatCommandArgs(task.id, {
    input: taskInputs[task.id] || '',
    advanced: advancedParams[task.id],
    formationMode: normalizeFormationMode(autoFormation[task.id]),
    // 预览确认输入未带 s 前缀的作业集时，执行也补上服务端要求的 s 前缀。
    autoAddSetPrefix: task.id === 'copilot'
      && preview?.type === 'set'
      && preview.autoAddS === true,
  })

  const handleStartNextCopilot = async () => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }
    await continueSet()
  }

  const handleCancelCopilotSet = () => {
    void stop()
  }

  const handleStopTask = async () => {
    await stop()
  }

  const handleExecute = async (task: CombatTask) => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }

    const inputValue = taskInputs[task.id] || ''
    const inputError = validateCombatInput(task.id, inputValue)
    if (inputError) {
      setStatusMessage(inputError)
      return
    }

    if (task.id === 'copilot' && !preview) {
      const firstArg = splitCopilotInputToArgs(inputValue)[0] || ''
      if (parseCopilotUri(firstArg)?.isSet) {
        await requestCopilotPreview(inputValue)
        setStatusMessage('已恢复作业集进度，请确认待执行关卡后再次执行')
        return
      }
    }

    if (task.id === 'copilot' && preview?.type === 'set' && preview.copilots?.length) {
      const selectedIndexes = getSelectedCopilotIndexes()
      if (!selectedIndexes.length) {
        setStatusMessage('请至少选择一个作业')
        return
      }

      await submitSet({
        setId: preview.id,
        mode: toCopilotSetRunMode(copilotSetExecutionMode),
        raid: normalizeRaidValue(advancedParams.copilot?.raid),
        selectedIndexes,
        options: buildCopilotSetExecutionOptions(
          advancedParams.copilot,
          normalizeFormationMode(autoFormation.copilot),
        ),
        taskName: task.name,
      })
      return
    }

    await submitTask({
      command: task.command,
      args: buildCommandArgs(task),
      taskName: task.name,
    })
  }

  const handleInputChange = (taskId: string, value: string) => {
    updateCombatConfig(current => ({
      ...current,
      taskInputs: { ...current.taskInputs, [taskId]: value },
    }))
    if (taskId === 'copilot') {
      clearCopilotPreview()
      if (value.trim() !== panelStores.copilotSearchSelection.get()) {
        panelStores.copilotSearchSelection.set('')
      }
    }
  }

  const handleAdvancedChange = (taskId: string, key: string, value: string | number | boolean) => {
    updateCombatConfig(current => ({
      ...current,
      advancedParams: {
        ...current.advancedParams,
        [taskId]: {
          ...(current.advancedParams[taskId] || {}),
          [key]: value,
        },
      },
    }))
  }

  const handleFormationChange = (taskId: string, mode: FormationMode) => {
    updateCombatConfig(current => ({
      ...current,
      autoFormation: { ...current.autoFormation, [taskId]: mode },
    }))
  }

  const handleSetExecutionModeChange = (mode: CopilotSetExecutionMode) => {
    updateCombatConfig(current => ({
      ...current,
      copilotSetExecutionMode: mode,
    }))
  }

  const requestCopilotPreview = useCallback(async (rawValue?: string) => {
    const raid = normalizeRaidValue(advancedParams.copilot?.raid)
    setStatusMessage('正在获取作业信息...')
    const outcome = await loadCopilotPreview({
      input: rawValue ?? (taskInputs['copilot'] || ''),
      mode: panelStores.copilotPreviewMode.get(),
      raid,
    })
    if (outcome.status === 'cancelled') return outcome

    if (outcome.status === 'ready') {
      if (outcome.preview.type === 'set') {
        restoreSelectedCopilots(outcome.preview.id, outcome.preview.copilots ?? [], raid)
      }
      setStatusMessage(outcome.message)
      return outcome
    }

    if (outcome.status === 'failed') {
      setStatusMessage(
        outcome.kind === 'transport' || outcome.kind === 'unknown'
          ? `网络错误: ${outcome.message}`
          : outcome.message,
      )
      return outcome
    }

    setStatusMessage(outcome.message)
    return outcome
  }, [
    advancedParams.copilot?.raid,
    loadCopilotPreview,
    panelStores.copilotPreviewMode,
    restoreSelectedCopilots,
    setStatusMessage,
    taskInputs,
  ])

  const applyCopilotUri = async (uri: string) => {
    const normalizedUri = normalizeCopilotInput(uri).trim()
    updateCombatConfig(current => ({
      ...current,
      taskInputs: { ...current.taskInputs, copilot: normalizedUri },
    }))
    panelStores.copilotSearchSelection.set(normalizedUri)
    clearCopilotPreview()
    await requestCopilotPreview(normalizedUri)
  }

  const handleSearchParadox = async (operatorName: string) => {
    if (isSearchingParadox) return
    if (!operatorName.trim()) {
      setStatusMessage('请输入干员名字')
      return
    }

    setStatusMessage('正在搜索作业...')
    const outcome = await searchParadoxJobs(operatorName)
    if (outcome.status === 'cancelled') return

    if (outcome.status === 'failed') {
      setStatusMessage(
        outcome.kind === 'transport' || outcome.kind === 'unknown'
          ? `搜索失败: ${outcome.message}`
          : outcome.message,
      )
      return
    }

    const { result } = outcome
    if (!result.copilots.length) {
      setStatusMessage('未找到作业')
      return
    }

    setStatusMessage(`找到 ${result.copilots.length} 个作业`)
    const recommendedUri = result.recommended?.uri
    if (recommendedUri) {
      updateCombatConfig(current => ({
        ...current,
        taskInputs: { ...current.taskInputs, paradoxcopilot: recommendedUri },
      }))
    }
  }

  const handleSearchCopilot = async (term: string) => {
    if (isSearchingCopilot) return
    if (!term.trim()) {
      setStatusMessage('请输入关卡名称')
      return
    }

    setStatusMessage('正在搜索作业...')
    const outcome = await searchCopilotJobs(term)
    if (outcome.status === 'cancelled') return

    if (outcome.status === 'failed') {
      setStatusMessage(
        outcome.kind === 'transport' || outcome.kind === 'unknown'
          ? `搜索失败: ${outcome.message}`
          : outcome.message,
      )
      return
    }

    const { result } = outcome
    if (!result.copilots.length) {
      setStatusMessage('未找到作业')
      return
    }

    if (result.recommended?.uri) {
      await applyCopilotUri(result.recommended.uri)
    } else {
      setStatusMessage(`找到 ${result.copilots.length} 个作业`)
    }
  }

  const applyParadoxUri = (uri: string) => {
    updateCombatConfig(current => ({
      ...current,
      taskInputs: { ...current.taskInputs, paradoxcopilot: uri },
    }))
  }

  const toggleSelectedCopilot = (index: number) => {
    if (!preview?.copilots) return
    applySelectedCopilotIndexes(
      toggleCopilotSelection(selectedCopilotIndexes, index),
      preview.id,
    )
  }

  const toggleAllCopilots = () => {
    if (!preview?.copilots) return
    applySelectedCopilotIndexes(
      toggleAllCopilotSelection(selectedCopilotIndexes, preview.copilots.length),
      preview.id,
    )
  }

  const copilotTask = getCombatTask('copilot')
  const specialTask = activeCombatMode === 'copilot' ? null : getCombatTask(activeCombatMode)

  const copilotConfig: CombatCopilotConfig = {
    input: taskInputs.copilot || '',
    advanced: advancedParams.copilot ?? {},
    formationMode: normalizeFormationMode(autoFormation.copilot),
    raid: normalizeRaidValue(advancedParams.copilot?.raid),
    setExecutionMode: copilotSetExecutionMode,
    onInputChange: value => handleInputChange('copilot', value),
    onAdvancedChange: (key, value) => handleAdvancedChange('copilot', key, value),
    onFormationChange: mode => handleFormationChange('copilot', mode),
    onSetExecutionModeChange: handleSetExecutionModeChange,
  }

  const copilotSelection: CombatCopilotSelectionProjection = {
    selected: selectedCopilotIndexes,
    isResetting: isResettingProgress,
    onToggle: toggleSelectedCopilot,
    onToggleAll: toggleAllCopilots,
    onOpenReset: () => setResetProgressDialogOpen(true),
  }

  const copilotSearch: CombatCopilotSearchProjection = {
    stageStore: panelStores.copilotSearchStage,
    selectionStore: panelStores.copilotSearchSelection,
    result: copilotSearchResult,
    searching: isSearchingCopilot,
    onSearch: term => void handleSearchCopilot(term),
    onCancel: cancelCopilotSearch,
    onSelectUri: uri => void applyCopilotUri(uri),
  }

  const paradoxSearch: CombatParadoxSearchProjection = {
    nameStore: panelStores.paradoxSearchName,
    result: paradoxSearchResult,
    searching: isSearchingParadox,
    onSearch: name => void handleSearchParadox(name),
    onCancel: cancelParadoxSearch,
    onSelectUri: applyParadoxUri,
  }

  const baseExecution: CombatExecutionActions = {
    automationAvailable,
    unavailableMessage,
    isRunning,
    isStopping,
    isSubmitting,
    isContinuing,
    onExecute: () => void handleExecute(copilotTask),
    onStop: () => void handleStopTask(),
  }

  const copilotExecution: CombatCopilotExecutionActions = {
    ...baseExecution,
    onStartNext: () => void handleStartNextCopilot(),
    onCancelSet: handleCancelCopilotSet,
  }

  return (
    <>
      {configSyncError && (
        <div
          role="alert"
          className="status-warning flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm leading-5"
        >
          <span className="min-w-0 flex-1">{configSyncError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={isRetryingConfigSave}
            loadingText="同步中"
            onClick={() => void handleRetryConfigSave()}
            className="min-h-11 shrink-0"
          >
            重新同步
          </Button>
        </div>
      )}

      <div className="combat-workspace-grid">
        <div className="combat-main-column">
          <CombatModeTabs activeMode={activeCombatMode} onSelect={setActiveCombatMode} />

          <CombatExecutionProgressPanel progress={executionProgress} />

          <div className="app-stack-section">
            {activeCombatMode === 'copilot' && (
              <CombatCopilotTaskPanel
                task={copilotTask}
                config={copilotConfig}
                preview={{
                  info: preview,
                  loading: isLoadingSet,
                  modeStore: panelStores.copilotPreviewMode,
                  onPreview: () => void requestCopilotPreview(),
                  onCancel: cancelCopilotPreview,
                  onClear: clearCopilotPreview,
                }}
                view={setView}
                selection={copilotSelection}
                search={copilotSearch}
                execution={copilotExecution}
              />
            )}

            {specialTask && (
              <CombatSpecialTaskPanel
                task={specialTask}
                input={taskInputs[specialTask.id] || ''}
                advanced={advancedParams[specialTask.id] ?? {}}
                onInputChange={value => handleInputChange(specialTask.id, value)}
                onAdvancedChange={(key, value) => handleAdvancedChange(specialTask.id, key, value)}
                paradoxSearch={specialTask.id === 'paradoxcopilot' ? paradoxSearch : undefined}
                execution={{
                  ...baseExecution,
                  onExecute: () => void handleExecute(specialTask),
                }}
              />
            )}
          </div>
        </div>

        <aside className="combat-monitor-column" aria-label="设备画面">
          <DeviceMonitorPanel
            className="combat-monitor-panel"
            surfaceClassName="combat-monitor-surface"
          />
        </aside>
      </div>

      <ConfirmDialog
        isOpen={resetProgressDialogOpen}
        onClose={() => setResetProgressDialogOpen(false)}
        onConfirm={resetCopilotSetProgress}
        title="重置作业集进度？"
        message="已记录的通关进度会被清除，下次将从第一关重新开始。"
        confirmText="确认重置"
        variant="danger"
      />
    </>
  )
}
