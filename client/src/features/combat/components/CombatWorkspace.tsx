/**
 * 作业工作区
 *
 * 页面唯一的作业领域容器：配置草稿、预览会话、搜索入口、执行订阅、作业集
 * 选择与重置进度都在这里接线。页面壳只组合本组件；卡片与面板只接收投影：
 *
 * - `activeCombatMode` 决定展示普通作业、保全派驻或悖论模拟，不写入配置；
 * - `selectedCopilotIndexes` 是跨面板的当前选择，提交与进度展示共用；
 * - 搜索词、识别方式与搜索选中项由工作区创建会话存储、面板订阅，输入变化
 *   不推动工作区或作业集列表重渲染；
 * - 作业集列表的续跑/失败/下一关视图由 `deriveCopilotSetView` 纯模型派生；
 * - 真正卸载时工作区与面板局部状态一起销毁，Activity 隐藏/恢复保留。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getErrorMessage } from '@/shared/api'
import { Button, ConfirmDialog, SmoothPanel } from '@/shared/ui'
import { useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { ScreenMonitor } from '@/features/device-mirror'
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
  const { setMessage: setStatusMessage } = useStatusStore()
  const { isAvailable: automationAvailable, unavailableMessage } = useAutomationAvailability()
  const {
    draft: configDraft,
    syncState: configSyncState,
    error: configSyncError,
    update: updateConfig,
    channel: configChannel,
    retry: retryConfigSave,
  } = useUserConfig(combatConfigAdapter)
  // 协调器负责草稿、pending、提交队列与加载次序；页面只从草稿派生当前字段并渲染同步状态。
  const {
    taskInputs,
    advancedParams,
    autoFormation,
    copilotSetExecutionMode,
    copilotSetSelections,
  } = configDraft ?? DEFAULT_COMBAT_CONFIG
  const isRetryingConfigSave = configSyncState === 'saving'
  const queryClient = useQueryClient()
  // 预览、取消与旧响应裁决由域会话持有；工作区只消费预览快照与动作。
  const {
    preview,
    isLoading: isLoadingSet,
    load: loadCopilotPreview,
    refreshSet: refreshCopilotSet,
    resetProgressView: resetCopilotProgressView,
    cancel: cancelCopilotPreview,
    clear: clearCopilotPreview,
  } = useCopilotPreview()
  // 搜索词、输入与选中项在面板侧；结果、取消与代次裁决仍由域 Query 入口持有。
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
  // 作业集任务选择状态（记录选中的索引）；跨列表与提交共享，归工作区。
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
    isWaitingForNext,
    isAutoStopping,
  })

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

  // 取消等待中的作业集：结束服务端 run，未开始的条目不会再执行。
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

    // 输入校验与 SSS 单 URI 限制由纯命令模型描述。
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

    // 作业集模式：整段队列交给服务端 Run，页面不再逐项编排。
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

    // 单个作业模式
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

  // 搜索悖论模拟作业
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
    // 自动填充推荐作业
    const recommendedUri = result.recommended?.uri
    if (recommendedUri) {
      updateCombatConfig(current => ({
        ...current,
        taskInputs: { ...current.taskInputs, paradoxcopilot: recommendedUri },
      }))
    }
  }

  // 搜索普通关卡作业
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

    // 自动填充并预览推荐作业
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

      <div className="task-monitor-layout">
        <div className="task-monitor-main">
          <CombatModeTabs activeMode={activeCombatMode} onSelect={setActiveCombatMode} />

          {/* 任务列表 */}
          <div className="app-stack-section">
            {/* 自动抄作业 - 单独一行 */}
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

            {/* 保全派驻 / 悖论模拟 */}
            <div className="app-stack-section">
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
        </div>

        <aside className="task-monitor-column" aria-label="模拟器实时预览">
          <SmoothPanel
            className="combat-monitor-panel"
            surfaceClassName="automation-monitor-surface combat-monitor-surface"
          >
            <div className="task-monitor-panel is-compact">
              <ScreenMonitor variant="compact" />
            </div>
          </SmoothPanel>
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
