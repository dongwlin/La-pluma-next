import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getErrorMessage } from '@/shared/api'
import { Button, ConfirmDialog } from '@/shared/ui'
import { useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { DeviceMonitorPanel } from '@/features/device-mirror'
import { isTerminalRunState } from '@/features/task-execution'
import { useUserConfig } from '@/features/user-config'
import { resetCopilotSetProgress as resetCopilotSetProgressRequest, uploadCopilotFile } from '../api'
import { useCombatExecution } from '../hooks/useCombatExecution'
import { useCopilotPreview } from '../hooks/useCopilotPreview'
import { useCopilotQueue } from '../hooks/useCopilotQueue'
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
  toCopilotQueueFailurePolicy,
  toCopilotSetRunMode,
  validateCombatInput,
} from '../model/combatCommands'
import {
  restorableCopilotIndexes,
  selectedCopilotItemIndexes,
  serializeCopilotSelection,
} from '../model/copilotSelection'
import { INVALID_COPILOT_URI_MESSAGE, resolveCopilotPreviewTarget } from '../model/copilotPreview'
import type { CopilotPreviewMode, CopilotPreviewOutcome } from '../model/copilotPreview'
import {
  buildCopilotQueueEntries,
  buildCopilotQueueEntryFromFile,
  checkedCopilotQueueEntries,
  COPILOT_QUEUE_LIMIT,
  type CopilotQueueEntry,
} from '../model/copilotQueue'
import { toCopilotQueueRunEntries } from '../model/copilotQueueRun'
import { collectCopilotItemErrors } from '../model/copilotDetail'
import { deriveCopilotSetView } from '../model/copilotSetView'
import { deriveExecutionProgress } from '../model/executionProgress'
import { createPanelStateStore } from '../model/panelState'
import { invalidateCopilotSetPlan, loadCopilotPreview as loadCopilotPreviewData } from '../model/queries'
import { normalizeCopilotInput, parseCopilotUri, splitCopilotInputToArgs } from '../utils/copilotUri'
import type {
  CombatMode,
  CombatTask,
  CopilotSetExecutionMode,
  CopilotSetInfo,
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
  CombatCopilotFileImportProjection,
  CombatCopilotQueueProjection,
  CombatCopilotSearchProjection,
  CombatCopilotSelectionProjection,
  CombatExecutionActions,
  CombatParadoxSearchProjection,
} from './combatPanelTypes'

/** 协调器加载完成前的渲染默认值；与迁移前的初始 state 一致。 */
const DEFAULT_COMBAT_CONFIG = createDefaultCombatDraft()

const COPILOT_QUEUE_RUN_ID = 'copilot-queue'
const COPILOT_QUEUE_RUN_NAME = '作业队列'

function previewMatchesInput(
  preview: CopilotSetInfo | null,
  input: string,
): preview is CopilotSetInfo {
  if (!preview) return false
  const parsed = parseCopilotUri(splitCopilotInputToArgs(input)[0] || '')
  if (!parsed || parsed.id !== preview.id) return false
  return preview.type === 'set' ? parsed.isSet || preview.autoAddS === true : !parsed.isSet
}

async function readCopilotFileText(file: File): Promise<string> {
  try {
    return await file.text()
  } catch {
    return ''
  }
}

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
  const [selectedCopilotSetId, setSelectedCopilotSetId] = useState<string | null>(null)
  const [isResettingProgress, setIsResettingProgress] = useState(false)
  const [isImportingCopilotFile, setIsImportingCopilotFile] = useState(false)
  const [isAddingToQueue, setIsAddingToQueue] = useState(false)
  const [addingQueueUri, setAddingQueueUri] = useState<string | null>(null)
  const [submittedEntryIds, setSubmittedEntryIds] = useState<ReadonlySet<string>>(() => new Set())
  const queueAddControllerRef = useRef<AbortController | null>(null)
  const queue = useCopilotQueue()
  const { syncSet: syncQueueSet } = queue
  const importingCopilotFileRef = useRef(false)
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

  useEffect(() => () => queueAddControllerRef.current?.abort(), [])

  const {
    isRunning,
    isWaitingForNext,
    isAutoStopping,
    isStopping,
    isContinuing,
    isSkipping,
    isSubmitting,
    setRun,
    queueRun,
    run: trackedRun,
    submitTask,
    submitSet,
    submitQueue,
    continueSet,
    continueQueue,
    skipQueueEntry,
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
    setSelectedCopilotSetId(setId)
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

  const activeSetPreview = preview?.type === 'set' ? preview : null
  const queueSetIndexes = new Set<number>()
  for (const entry of queue.entries) {
    if (
      activeSetPreview
      && entry.setId === activeSetPreview.id
      && entry.setItemIndex !== undefined
      && queue.selected.has(entry.id)
    ) {
      queueSetIndexes.add(entry.setItemIndex)
    }
  }

  const setView = deriveCopilotSetView({
    preview,
    selected: queueSetIndexes,
    setRun,
    dismissedRunId,
    raid: normalizeRaidValue(advancedParams.copilot?.raid),
    isWaitingForNext,
    isAutoStopping,
  })

  useEffect(() => {
    if (!activeSetPreview) return
    const copilots = activeSetPreview.copilots ?? []
    const raid = normalizeRaidValue(advancedParams.copilot?.raid)
    const checkedIndexes = selectedCopilotSetId === activeSetPreview.id
      ? [...selectedCopilotIndexes].filter(index => index >= 0 && index < copilots.length)
      : restorableCopilotIndexes(copilots, raid, copilotSetSelections[activeSetPreview.id])
    syncQueueSet(activeSetPreview.id, buildCopilotQueueEntries(activeSetPreview), checkedIndexes)
  }, [
    activeSetPreview,
    advancedParams.copilot?.raid,
    copilotSetSelections,
    selectedCopilotIndexes,
    selectedCopilotSetId,
    syncQueueSet,
  ])

  const executionProgress = useMemo(
    () => deriveExecutionProgress(trackedRun, setRun),
    [trackedRun, setRun],
  )

  const queueItemErrors = useMemo(() => {
    const run = setView.activeSetRun
    if (!run) return new Map<number, string>()
    return collectCopilotItemErrors(run.failures, run.summaryErrors ?? [])
  }, [setView.activeSetRun])

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

  const executeCheckedQueue = async (entries: readonly CopilotQueueEntry[]) => {
    const setIndexes: number[] = []
    let setBacked = activeSetPreview !== null
    for (const entry of entries) {
      if (
        !activeSetPreview
        || entry.setId !== activeSetPreview.id
        || entry.setItemIndex === undefined
      ) {
        setBacked = false
        break
      }
      setIndexes.push(entry.setItemIndex)
    }
    const ordered = setBacked && setIndexes.every(
      (index, position) => position === 0 || index > setIndexes[position - 1]!,
    )

    setSubmittedEntryIds(new Set())
    if (activeSetPreview && setBacked && ordered) {
      await submitSet({
        setId: activeSetPreview.id,
        mode: toCopilotSetRunMode(copilotSetExecutionMode),
        raid: normalizeRaidValue(advancedParams.copilot?.raid),
        selectedIndexes: setIndexes,
        options: buildCopilotSetExecutionOptions(
          advancedParams.copilot,
          normalizeFormationMode(autoFormation.copilot),
        ),
        taskName: copilotTask.name,
      })
      return
    }

    await executeQueueRun(entries)
  }

  const handleExecute = async (task: CombatTask) => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }

    const queueEntries = task.id === 'copilot'
      ? checkedCopilotQueueEntries(queue.entries, queue.selected)
      : []
    if (queueEntries.length) {
      if (isRunning || isSubmitting) {
        setStatusMessage('正在执行其他任务，请稍后再试', 'warning')
        return
      }
      await executeCheckedQueue(queueEntries)
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

  const handleImportCopilotFile = async (file: File) => {
    if (importingCopilotFileRef.current) return
    importingCopilotFileRef.current = true
    setIsImportingCopilotFile(true)
    try {
      const result = await uploadCopilotFile(file)
      if (!result.success || !result.data?.path) {
        setStatusMessage(getErrorMessage(result), 'error')
        return
      }
      const content = await readCopilotFileText(file)
      queue.add([buildCopilotQueueEntryFromFile(
        result.data.path,
        result.data.name || file.name,
        content,
      )])
      clearCopilotPreview()
      setStatusMessage(`已导入本地作业: ${result.data.name || file.name}`, 'success')
    } catch (error) {
      setStatusMessage(getErrorMessage({ message: error instanceof Error ? error.message : undefined }), 'error')
    } finally {
      importingCopilotFileRef.current = false
      setIsImportingCopilotFile(false)
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

  const resolveQueuePreview = async (
    input: string,
    mode = panelStores.copilotPreviewMode.get(),
  ): Promise<{
    preview: CopilotSetInfo | null
    outcome: CopilotPreviewOutcome | null
  }> => {
    const target = resolveCopilotPreviewTarget(input, mode)
    if (!target) {
      return {
        preview: null,
        outcome: { status: 'invalid', message: INVALID_COPILOT_URI_MESSAGE },
      }
    }
    queueAddControllerRef.current?.abort()
    const controller = new AbortController()
    queueAddControllerRef.current = controller
    const outcome = await loadCopilotPreviewData(queryClient, {
      target,
      raid: normalizeRaidValue(advancedParams.copilot?.raid),
    }, {
      signal: controller.signal,
      force: false,
      track: () => {},
    })
    return {
      preview: outcome.status === 'ready' ? outcome.preview : null,
      outcome,
    }
  }

  const reportQueueAdd = (preview: CopilotSetInfo) => {
    if (preview.type === 'set') {
      const raid = normalizeRaidValue(advancedParams.copilot?.raid)
      const existingEntries = queue.entries.filter(entry => entry.setId === preview.id)
      const checkedIndexes = existingEntries.length
        ? existingEntries
          .filter(entry => entry.setItemIndex !== undefined && queue.selected.has(entry.id))
          .map(entry => entry.setItemIndex as number)
        : restorableCopilotIndexes(
          preview.copilots ?? [],
          raid,
          copilotSetSelections[preview.id],
        )
      syncQueueSet(preview.id, buildCopilotQueueEntries(preview), checkedIndexes)
      setStatusMessage(`已同步作业集 ${preview.copilots?.length ?? 0} 个作业到队列`, 'success')
      return
    }
    const wasFull = queue.entries.length >= COPILOT_QUEUE_LIMIT
    const added = queue.add(buildCopilotQueueEntries(preview))
    setStatusMessage(
      added
        ? `已加入 ${added} 个作业到队列`
        : wasFull
          ? `队列已满，最多 ${COPILOT_QUEUE_LIMIT} 个作业`
          : '这些作业已在队列中',
      added ? 'success' : 'warning',
    )
  }

  const reportQueueAddFailure = (outcome: CopilotPreviewOutcome) => {
    if (outcome.status === 'cancelled') return
    if (outcome.status === 'failed') {
      setStatusMessage(
        outcome.kind === 'transport' || outcome.kind === 'unknown'
          ? `网络错误: ${outcome.message}`
          : outcome.message,
        'error',
      )
      return
    }
    if (outcome.status === 'invalid' || outcome.status === 'empty') {
      setStatusMessage(outcome.message)
    }
  }

  const handleAddToQueue = async () => {
    if (isAddingToQueue) return
    const inputValue = taskInputs.copilot || ''
    if (!inputValue.trim()) {
      setStatusMessage('请输入作业链接')
      return
    }
    if (previewMatchesInput(preview, inputValue)) {
      reportQueueAdd(preview)
      return
    }

    setIsAddingToQueue(true)
    try {
      const outcome = await requestCopilotPreview(inputValue)
      if (outcome.status === 'ready') reportQueueAdd(outcome.preview)
    } finally {
      setIsAddingToQueue(false)
    }
  }

  const handleAddSearchUriToQueue = async (uri: string) => {
    if (isAddingToQueue) return

    setIsAddingToQueue(true)
    setAddingQueueUri(uri)
    setStatusMessage('正在获取作业信息...')
    try {
      const { preview: loaded, outcome } = await resolveQueuePreview(uri, 'auto')
      if (loaded) {
        reportQueueAdd(loaded)
        return
      }
      if (outcome) reportQueueAddFailure(outcome)
    } finally {
      setIsAddingToQueue(false)
      setAddingQueueUri(null)
    }
  }

  const executeQueueRun = async (entries: readonly CopilotQueueEntry[]) => {
    const raid = normalizeRaidValue(advancedParams.copilot?.raid)
    const entryMode = raid === 'raid' ? 'raid' : 'normal'
    const runEntries = toCopilotQueueRunEntries(entries, entryMode)
    if (!runEntries.length || runEntries.length !== entries.length) {
      setStatusMessage('队列中存在无法解析的作业链接', 'error')
      return false
    }
    if (raid === 'both') {
      setStatusMessage('自定义队列暂不支持普通+突袭双模式，本次按普通模式执行', 'warning')
    }

    const submitted = await submitQueue({
      queueId: COPILOT_QUEUE_RUN_ID,
      name: COPILOT_QUEUE_RUN_NAME,
      mode: toCopilotSetRunMode(copilotSetExecutionMode),
      failurePolicy: toCopilotQueueFailurePolicy(advancedParams.copilot?.executionStrategy),
      entries: runEntries,
      options: buildCopilotSetExecutionOptions(
        advancedParams.copilot,
        normalizeFormationMode(autoFormation.copilot),
      ),
      taskName: copilotTask.name,
    })
    if (submitted) setSubmittedEntryIds(new Set(entries.map(entry => entry.id)))
    return submitted
  }

  const selectQueueEntries = (ids: readonly string[]) => {
    const target = new Set(ids)
    for (const entry of queue.entries) {
      if (target.has(entry.id) !== queue.selected.has(entry.id)) queue.toggle(entry.id)
    }
  }

  const handleContinueQueue = async () => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }
    await continueQueue()
  }

  const handleSkipQueueEntry = async () => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }
    await skipQueueEntry()
  }

  const handleRetryFailedQueue = async () => {
    const failedEntries = queueRun?.isTerminal
      ? queue.entries.filter(entry => queueRun.statuses.get(entry.id)?.status === 'failed')
      : []
    if (!failedEntries.length) {
      setStatusMessage('没有可重试的失败项', 'warning')
      return
    }
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }
    if (isRunning || isSubmitting) {
      setStatusMessage('正在执行其他任务，请稍后再试', 'warning')
      return
    }
    selectQueueEntries(failedEntries.map(entry => entry.id))
    setSubmittedEntryIds(new Set())
    await executeQueueRun(failedEntries)
  }

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
    isResetting: isResettingProgress,
    onOpenReset: () => setResetProgressDialogOpen(true),
  }

  const copilotFileImport: CombatCopilotFileImportProjection = {
    isImporting: isImportingCopilotFile,
    onImport: file => void handleImportCopilotFile(file),
  }

  const copilotSearch: CombatCopilotSearchProjection = {
    stageStore: panelStores.copilotSearchStage,
    selectionStore: panelStores.copilotSearchSelection,
    result: copilotSearchResult,
    searching: isSearchingCopilot,
    addingUri: addingQueueUri,
    onSearch: term => void handleSearchCopilot(term),
    onCancel: cancelCopilotSearch,
    onSelectUri: uri => void applyCopilotUri(uri),
    onAddToQueue: uri => void handleAddSearchUriToQueue(uri),
  }

  const copilotQueue: CombatCopilotQueueProjection = {
    entries: queue.entries,
    selected: queue.selected,
    setId: activeSetPreview?.id ?? null,
    itemStatuses: setView.itemStatuses,
    itemErrors: queueItemErrors,
    submittedEntryIds,
    queueRun,
    failurePolicy: toCopilotQueueFailurePolicy(advancedParams.copilot?.executionStrategy),
    isRunning,
    isSubmitting,
    isContinuing,
    isSkipping,
    isAdding: isAddingToQueue,
    addingUri: addingQueueUri,
    automationAvailable,
    unavailableMessage,
    onToggle: queue.toggle,
    onRemove: queue.remove,
    onMove: queue.move,
    onClear: queue.clear,
    onAddCurrent: () => void handleAddToQueue(),
    onAddUri: uri => void handleAddSearchUriToQueue(uri),
    onContinueQueue: () => void handleContinueQueue(),
    onSkipEntry: () => void handleSkipQueueEntry(),
    onRetryFailed: () => void handleRetryFailedQueue(),
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
    isWaitingForNext: setView.waitingEntry !== null,
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
                fileImport={copilotFileImport}
                view={setView}
                selection={copilotSelection}
                queue={copilotQueue}
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
