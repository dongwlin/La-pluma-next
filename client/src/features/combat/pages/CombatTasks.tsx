import { useState, useEffect, useRef, useCallback } from 'react'
import { getErrorMessage } from '@/shared/api'
import {
  getCopilotInfo,
  getCopilotSet,
  getCopilotSetPlan,
  resetCopilotSetProgress as resetCopilotSetProgressRequest,
  searchCopilot,
  searchParadoxCopilot,
} from '../api'
import { motion, useReducedMotion } from 'framer-motion'
import { FileText, Info, Play, Square } from 'lucide-react'
import Icons from '@/shared/ui/Icons'
import { PageHeader, Button, Card, ConfirmDialog, EmptyState, SmoothPanel } from '@/shared/ui'
import { FloatingStatusIndicator, useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { ScreenMonitor } from '@/features/device-mirror'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import { isTerminalRunState } from '@/features/task-execution'
import { normalizeCopilotInput, parseCopilotUri, splitCopilotInputToArgs } from '../utils/copilotUri'
import type {
  CombatTask,
  CombatAdvancedOption,
  FormationMode,
  CopilotSetInfo,
  CopilotSearchResult,
  ParadoxSearchResult,
  CopilotSetItem,
  CopilotSetExecutionMode
} from '../types'
import { useUserConfig } from '@/features/user-config'
import {
  combatConfigAdapter,
  createDefaultCombatDraft,
  normalizeRaidValue,
} from '../model/combatConfig'
import type { CombatConfigDraft } from '../model/combatConfig'
import { useCombatExecution } from '../hooks/useCombatExecution'
import type { CopilotSetItemStatus } from '../model/copilotSetRun'

type CombatMode = 'copilot' | 'ssscopilot' | 'paradoxcopilot'

/** 协调器加载完成前的渲染默认值；与迁移前的初始 state 一致。 */
const DEFAULT_COMBAT_CONFIG = createDefaultCombatDraft()

const serializeSelectedCopilotIndexes = (indexes: Set<number>): number[] =>
  [...indexes].filter(Number.isInteger).sort((a, b) => a - b)

// 从作业内容中提取干员列表（包含固定干员和干员组）
const extractOperators = (content: any): string => {
  const opers = content.opers?.map((op: any) => op.name) || []
  const groups = content.groups?.map((g: any) => `[${g.name}]`) || []
  const allOpers = [...opers, ...groups]
  return allOpers.length > 0 ? allOpers.join('、') : '未知'
}

const unwrapApiPayload = (response: any) => {
  if (!response || typeof response !== 'object') return null
  if (response.success === true && response.data) return response.data
  return response
}

const getCopilotContent = (response: any) => {
  const payload = unwrapApiPayload(response)
  if (payload?.status_code !== 200 || !payload?.data?.content) return null
  try {
    return JSON.parse(payload.data.content)
  } catch {
    return null
  }
}

const getCopilotSetIds = (response: any): number[] => {
  const payload = unwrapApiPayload(response)
  const rawIds = payload?.data?.copilot_ids
  return Array.isArray(rawIds) ? rawIds.map((id: unknown) => Number(id)).filter(Number.isFinite) : []
}

const fetchCopilotDetail = async (copilotId: number): Promise<CopilotSetItem | null> => {
  try {
    const response = await getCopilotInfo(String(copilotId))
    const content = getCopilotContent(response)
    if (content) {
      return {
        id: copilotId,
        name: content.doc?.title || '未命名作业',
        stage: content.stage_name,
        operators: extractOperators(content),
        uri: `prts://${copilotId}`
      }
    }
  } catch {
    // 忽略单个作业获取失败
  }
  return { id: copilotId, uri: `prts://${copilotId}` }
}

// 获取作业集详情（包含所有作业列表）
const fetchCopilotSetDetails = async (
  setId: string,
  raid: 'normal' | 'raid' | 'both',
): Promise<CopilotSetItem[]> => {
  let plan: any = null
  try {
    const planResponse = await getCopilotSetPlan(setId, raid)
    plan = unwrapApiPayload(planResponse)
  } catch {
    // 计划接口失败时继续尝试集合列表，避免丢弃仍可执行的作业
  }
  if (Array.isArray(plan?.items) && plan.items.length > 0) {
    return plan.items.map((item: any, itemIndex: number) => ({
      id: Number(item.id),
      name: item.stage || `作业 #${item.id}`,
      stage: item.stage,
      stageId: item.stageId,
      presetFormation: Boolean(item.presetFormation),
      supportsRaid: item.supportsRaid !== false,
      completedModes: Array.isArray(plan.entries)
        ? plan.entries
            .filter((entry: any) => entry.itemIndex === itemIndex && entry.completed)
            .map((entry: any) => entry.mode as 'normal' | 'raid')
        : [],
      uri: `prts://${item.id}`
    }))
  }
  try {
    const data = await getCopilotSet(setId)
    const copilotIds = getCopilotSetIds(data)
    if (copilotIds.length > 0) {
      // 并行获取所有作业详情
      const details = await Promise.all(copilotIds.map(id => fetchCopilotDetail(id)))
      return details.filter((item): item is CopilotSetItem => item !== null)
    }
  } catch {
    // 忽略集合列表获取错误
  }
  return []
}

export default function CombatTasks() {
  const shouldReduceMotion = useReducedMotion()
  const [isResettingProgress, setIsResettingProgress] = useState(false)
  const [resetProgressDialogOpen, setResetProgressDialogOpen] = useState(false)
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
  const [copilotSetInfo, setCopilotSetInfo] = useState<CopilotSetInfo | null>(null)
  const [isLoadingSet, setIsLoadingSet] = useState(false)
  const previewRequestRef = useRef(0)
  const copilotSearchRequestRef = useRef(0)
  const paradoxSearchRequestRef = useRef(0)
  const reconciledRunRef = useRef<string | null>(null)
  // 用户重置进度后，旧 run 的逐项结果不再属于当前预览。
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null)

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

  // 作业类型选择：'auto' 自动检测，'single' 单个作业，'set' 作业集
  const [copilotType, setCopilotType] = useState<'auto' | 'single' | 'set'>('auto')

  // 作业集任务选择状态（记录选中的索引）
  const [selectedCopilotIndexes, setSelectedCopilotIndexes] = useState<Set<number>>(new Set())

  // 悖论模拟搜索相关状态
  const [paradoxSearchName, setParadoxSearchName] = useState('')
  const [paradoxSearchResult, setParadoxSearchResult] = useState<ParadoxSearchResult | null>(null)
  const [isSearchingParadox, setIsSearchingParadox] = useState(false)

  // 普通关卡搜索相关状态
  const [copilotSearchStage, setCopilotSearchStage] = useState('')
  const [copilotSearchResult, setCopilotSearchResult] = useState<CopilotSearchResult | null>(null)
  const [selectedSearchCopilotUri, setSelectedSearchCopilotUri] = useState<string>('')
  const [isSearchingCopilot, setIsSearchingCopilot] = useState(false)
  const [activeCombatMode, setActiveCombatMode] = useState<CombatMode>('copilot')
  const {
    containerRef: combatModeTabsRef,
    activeRect: activeCombatModeRect,
    setTabRef: setCombatModeTabRef,
    handleTabKeyDown: handleCombatModeKeyDown,
  } = useFluidTabIndicator(activeCombatMode)

  useEffect(() => {
    // Activity retains state while hidden, so clear loading left behind by
    // requests invalidated during the previous cleanup when effects resume.
    setIsLoadingSet(false)
    setIsSearchingCopilot(false)
    setIsSearchingParadox(false)

    return () => {
      previewRequestRef.current += 1
      copilotSearchRequestRef.current += 1
      paradoxSearchRequestRef.current += 1
    }
  }, [])

  const normalizeFormationMode = (value: unknown): FormationMode => {
    if (value === true) return 'on'
    if (value === false) return 'off'
    if (value === 'on' || value === 'off' || value === 'auto') return value
    return 'auto'
  }

  const getFormationMode = (taskId: string): FormationMode => normalizeFormationMode(autoFormation[taskId])

  const shouldAppendFormation = (taskId: string, forceForSplitSet = false): boolean => {
    if (taskId !== 'copilot') return false
    const mode = getFormationMode(taskId)
    if (mode === 'on') return true
    if (mode === 'off') return false
    return forceForSplitSet
  }

  const getSelectedCopilotIndexes = (): number[] => {
    if (!copilotSetInfo?.copilots?.length) return []
    return copilotSetInfo.copilots
      .map((_, index) => index)
      .filter(index => selectedCopilotIndexes.has(index))
  }

  const applySelectedCopilotIndexes = useCallback((indexes: Set<number>, setId: string) => {
    const normalized = new Set(serializeSelectedCopilotIndexes(indexes))
    setSelectedCopilotIndexes(normalized)
    updateCombatConfig(current => ({
      ...current,
      copilotSetSelections: {
        ...current.copilotSetSelections,
        [setId]: serializeSelectedCopilotIndexes(normalized),
      },
    }))
  }, [updateCombatConfig])

  // 服务端计划进度是“待执行”的唯一来源：成功的条目从选择中移除，失败项保留待重试。
  const restoreSelectedCopilots = useCallback((
    setId: string,
    copilots: CopilotSetItem[],
    raid: 'normal' | 'raid' | 'both',
  ) => {
    const savedIndexes = copilotSetSelections[setId]
    const pendingIndexes = copilots
      .map((copilot, index) => {
        const requiredModes: Array<'normal' | 'raid'> = copilot.presetFormation
          ? ['normal']
          : raid === 'both'
            ? ['normal', 'raid']
            : [raid === 'raid' ? 'raid' : 'normal']
        return requiredModes.every(mode => copilot.completedModes?.includes(mode)) ? -1 : index
      })
      .filter(index => index >= 0)
    const indexes = Array.isArray(savedIndexes)
      ? savedIndexes.filter(index => Number.isInteger(index) && pendingIndexes.includes(index))
      : pendingIndexes
    applySelectedCopilotIndexes(new Set(indexes), setId)
  }, [applySelectedCopilotIndexes, copilotSetSelections])

  const resetCopilotSetProgress = async () => {
    if (!copilotSetInfo?.copilots?.length) return false
    if (isResettingProgress) return false

    setIsResettingProgress(true)
    try {
      const result = await resetCopilotSetProgressRequest(copilotSetInfo.id)
      if (!result.success) {
        throw new Error(getErrorMessage(result))
      }
      applySelectedCopilotIndexes(new Set(copilotSetInfo.copilots.map((_, index) => index)), copilotSetInfo.id)
      setCopilotSetInfo(prev => prev ? { ...prev, currentIndex: 0 } : prev)
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

  // 配置加载、pending 本地优先与迟到响应丢弃都由 user-config 协调器负责；
  // 运行状态由应用级执行控制器按 Run 快照观察，页面不在挂载时恢复第二份执行状态。

  const tasks: CombatTask[] = [
    {
      id: 'copilot',
      name: '自动战斗作业',
      command: 'copilot',
      placeholder: 'prts://1234、作业站链接或本地文件路径',
      icon: <Icons.Document />,
      hasAdvanced: true,
      description: '支持单作业、作业集、作业站链接、循环次数与失败处理策略'
    },
    {
      id: 'ssscopilot',
      name: '保全派驻',
      command: 'ssscopilot',
      placeholder: 'prts://1234 或本地文件路径',
      icon: <Icons.Shield />,
      hasAdvanced: true,
      description: '保全派驻作业入口，一次只能执行一份作业'
    },
    {
      id: 'paradoxcopilot',
      name: '悖论模拟',
      command: 'paradoxcopilot',
      placeholder: 'prts://1234 或本地文件路径',
      icon: <Icons.Puzzle />,
      hasAdvanced: true,
      description: '悖论模拟独立作业入口，可按干员搜索推荐作业并单独诊断'
    },
  ]

  const getAdvancedOptions = (taskId: string): CombatAdvancedOption[] => {
    const options: Record<string, CombatAdvancedOption[]> = {
      copilot: [
        { key: 'ignoreRequirements', label: '忽略干员要求', type: 'checkbox', param: '--ignore-requirements' },
        { key: 'loopTimes', label: '循环次数', type: 'number', param: '--loop-times', placeholder: '1' },
        { key: 'executionStrategy', label: '队列策略', type: 'select', param: '', options: [
          { value: 'continue', label: '失败继续下一个' },
          { value: 'stop', label: '失败后停止' },
        ]},
        { key: 'formationIndex', label: '编队选择', type: 'select', param: '--formation-index', options: [
          { value: '', label: '当前编队' },
          { value: '1', label: '编队 1' },
          { value: '2', label: '编队 2' },
          { value: '3', label: '编队 3' },
          { value: '4', label: '编队 4' },
        ]},
        { key: 'addTrust', label: '按信赖值填充空位', type: 'checkbox', param: '--add-trust' },
        { key: 'useSanityPotion', label: '理智不足时使用理智药', type: 'checkbox', param: '--use-sanity-potion' },
        { key: 'supportUsage', label: '助战使用模式', type: 'select', param: '--support-unit-usage', options: [
          { value: '0', label: '不使用助战' },
          { value: '1', label: '缺一个时使用' },
          { value: '2', label: '使用指定助战' },
          { value: '3', label: '使用随机助战' },
        ]},
        { key: 'supportName', label: '助战干员名称', type: 'text', param: '--support-unit-name', placeholder: '干员名称' },
      ],
      ssscopilot: [
        { key: 'loopTimes', label: '循环次数', type: 'number', param: '--loop-times', placeholder: '1' },
      ],
      paradoxcopilot: [
        { key: 'executionStrategy', label: '队列策略', type: 'select', param: '', options: [
          { value: 'continue', label: '失败继续' },
          { value: 'stop', label: '失败停止' },
        ]},
      ],
    }
    return options[taskId] || []
  }

  const appendCommandOptions = (args: string[], task: CombatTask, forceFormationForSplitSet = false): string[] => {
    const nextArgs = [...args]
    if (shouldAppendFormation(task.id, forceFormationForSplitSet)) {
      nextArgs.push('--formation')
    }

    const advanced = advancedParams[task.id] || {}
    const raidValue = normalizeRaidValue(advanced.raid)
    if (task.id === 'copilot' && raidValue !== 'normal') {
      nextArgs.push('--raid', raidValue)
    }

    getAdvancedOptions(task.id).forEach(option => {
      const value = advanced[option.key]
      if (!option.param || value === undefined || value === '' || value === false) return
      if (option.type === 'checkbox' && value === true) {
        nextArgs.push(option.param)
      } else if (option.type !== 'checkbox') {
        nextArgs.push(option.param, String(value))
      }
    })

    return nextArgs
  }

  const buildCommandArgs = (task: CombatTask): string[] => {
    const args = splitCopilotInputToArgs(taskInputs[task.id] || '')

    if (task.id === 'copilot' && copilotSetInfo?.type === 'set' && copilotSetInfo?.autoAddS) {
      for (let i = 0; i < args.length; i++) {
        args[i] = (args[i] || '').replace(/^prts:\/\/(\d+)$/i, 'prts://s$1')
      }
    }

    return appendCommandOptions(args, task)
  }

  // 作业集 Run 属于当前预览时，逐项状态与失败汇总才用于列表展示；
  // 其它作业集或其它领域发起的 run 不会被当成当前预览的结果。
  const activeSetRun = setRun
    && dismissedRunId !== setRun.runId
    && copilotSetInfo?.type === 'set'
    && setRun.setId === copilotSetInfo.id
    ? setRun
    : null
  const setItemStatus = (index: number): CopilotSetItemStatus | undefined =>
    activeSetRun?.itemStatuses.get(index)
  const runCurrentIndex = activeSetRun?.currentItemIndex ?? null
  const runSuccessIndexes = new Set(
    [...(activeSetRun?.itemStatuses.entries() ?? [])]
      .filter(([, status]) => status === 'success')
      .map(([index]) => index),
  )
  // “待执行”= 页面选择减去本次 run 已成功的条目；终态后按服务端计划进度重建选择，
  // 因此失败与未开始项保留，成功项自动移出。
  const pendingSelectedIndexes = [...selectedCopilotIndexes]
    .filter(index => !runSuccessIndexes.has(index))
    .sort((a, b) => a - b)
  const pendingSelectedCount = pendingSelectedIndexes.length
  const setRunFailedCount = activeSetRun
    ? [...activeSetRun.itemStatuses.values()].filter(status => status === 'failed' || status === 'stopped').length
    : 0
  const setRunAttemptedCount = activeSetRun
    ? [...activeSetRun.itemStatuses.values()].filter(status => status !== 'pending').length
    : 0
  const waitingEntry = isWaitingForNext && !isAutoStopping ? activeSetRun?.nextEntry ?? null : null
  const waitingEntryIndex = waitingEntry?.itemIndex ?? null
  const waitingCopilot = waitingEntryIndex !== null
    ? copilotSetInfo?.copilots?.[waitingEntryIndex] ?? null
    : null
  const resumeIndex = waitingEntryIndex ?? pendingSelectedIndexes[0] ?? -1

  // 终态后按服务端计划进度重建“待执行”选择。成功的条目会被计划标记为已完成，
  // 失败的条目保留待重试；同步失败只影响展示，不把 run 结果解释成完成。
  useEffect(() => {
    if (!activeSetRun || activeSetRun.isActive) return
    if (!isTerminalRunState(activeSetRun.state)) return
    const setId = activeSetRun.setId
    if (!setId) return
    if (reconciledRunRef.current === activeSetRun.runId) return
    reconciledRunRef.current = activeSetRun.runId

    const requestId = ++previewRequestRef.current
    const raid = normalizeRaidValue(activeSetRun.raid ?? advancedParams.copilot?.raid)
    void (async () => {
      const copilots = await fetchCopilotSetDetails(setId, raid)
      if (previewRequestRef.current !== requestId || !copilots.length) return
      setCopilotSetInfo(prev => (prev?.id === setId ? { ...prev, copilots, currentIndex: 0 } : prev))
      restoreSelectedCopilots(setId, copilots, raid)
    })()
  }, [activeSetRun, advancedParams.copilot?.raid, restoreSelectedCopilots])

  // 继续 manual 作业集的下一关：等待态与下一项都由服务端持有，页面只发送继续意图。
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

    // 验证输入
    const inputValue = taskInputs[task.id] || ''
    if (task.id === 'copilot' || task.id === 'paradoxcopilot' || task.id === 'ssscopilot') {
      // copilot 任务需要输入作业 URI
      if (!inputValue.trim()) {
        setStatusMessage('请输入作业链接')
        return
      }
    }

    if (task.id === 'ssscopilot') {
      const args = splitCopilotInputToArgs(inputValue)
      if (args.length !== 1) {
        setStatusMessage('保全派驻一次只能执行一个 SSS 作业 URI')
        return
      }
    }

    if (task.id === 'copilot' && !copilotSetInfo) {
      const firstArg = splitCopilotInputToArgs(inputValue)[0] || ''
      if (parseCopilotUri(firstArg)?.isSet) {
        await handlePreviewCopilotSetWithInput(inputValue)
        setStatusMessage('已恢复作业集进度，请确认待执行关卡后再次执行')
        return
      }
    }

    // 作业集模式：整段队列交给服务端 Run，页面不再逐项编排。
    if (task.id === 'copilot' && copilotSetInfo?.type === 'set' && copilotSetInfo.copilots?.length) {
      const selectedIndexes = getSelectedCopilotIndexes()
      if (!selectedIndexes.length) {
        setStatusMessage('请至少选择一个作业')
        return
      }

      await submitSet({
        setId: copilotSetInfo.id,
        mode: copilotSetExecutionMode === 'manual' ? 'manual' : 'continuous',
        raid: normalizeRaidValue(advancedParams.copilot?.raid),
        selectedIndexes,
        options: {
          ignoreRequirements: advancedParams.copilot?.ignoreRequirements,
          loopTimes: advancedParams.copilot?.loopTimes,
          useSanityPotion: advancedParams.copilot?.useSanityPotion,
          addTrust: advancedParams.copilot?.addTrust,
          formationIndex: advancedParams.copilot?.formationIndex,
          supportUsage: advancedParams.copilot?.supportUsage,
          supportName: advancedParams.copilot?.supportName,
          formationMode: getFormationMode(task.id)
        },
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
      previewRequestRef.current += 1
      setIsLoadingSet(false)
      setCopilotSetInfo(null)
      if (value.trim() !== selectedSearchCopilotUri) {
        setSelectedSearchCopilotUri('')
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

  const applyCopilotUri = async (uri: string) => {
    const normalizedUri = normalizeCopilotInput(uri).trim()
    updateCombatConfig(current => ({
      ...current,
      taskInputs: { ...current.taskInputs, copilot: normalizedUri },
    }))
    setSelectedSearchCopilotUri(normalizedUri)
    setCopilotSetInfo(null)
    await handlePreviewCopilotSetWithInput(normalizedUri)
  }

  const handlePreviewCopilotSetWithInput = async (rawValue?: string) => {
    const requestId = ++previewRequestRef.current
    const isCurrentRequest = () => previewRequestRef.current === requestId
    const rawInput = rawValue ?? (taskInputs['copilot'] || '')
    const normalizedInput = normalizeCopilotInput(rawInput).trim()
    const firstToken = normalizedInput.split(/\s+/)[0] || ''
    const parsed = parseCopilotUri(firstToken)

    if (!parsed) {
      setStatusMessage('请输入有效的作业 URI / 作业站链接（如: prts://26766）')
      return
    }

    const copilotId = parsed.id
    const hasS = parsed.isSet
    const raid = normalizeRaidValue(advancedParams.copilot?.raid)
    // 新协议明确区分单作业与作业集；旧的无后缀输入保留自动探测。
    const inferredType = hasS ? 'set' : /^prts:\/\//i.test(rawInput.trim()) ? 'single' : 'auto'
    const resolvedType = copilotType === 'auto' ? inferredType : copilotType
    setIsLoadingSet(true)
    setStatusMessage('正在获取作业信息...')

    try {
      // 根据用户选择或自动检测模式
      if (resolvedType === 'single') {
        // 强制单个作业模式
        const copilotData = await getCopilotInfo(copilotId)
        if (!isCurrentRequest()) return
        const content = getCopilotContent(copilotData)
        if (content) {
          setCopilotSetInfo({
            type: 'single',
            id: copilotId,
            name: content.doc?.title || '未命名作业',
            stage: content.stage_name,
            operators: extractOperators(content)
          })
          setStatusMessage(`已加载作业：${content.doc?.title || content.stage_name}`)
        } else {
          setStatusMessage('作业不存在')
        }
      } else if (resolvedType === 'set') {
        // 强制作业集模式
        const copilots = await fetchCopilotSetDetails(copilotId, raid)
        if (!isCurrentRequest()) return
        if (copilots.length > 0) {
          setCopilotSetInfo({
            type: 'set',
            id: copilotId,
            name: `作业集 (${copilots.length} 个作业)`,
            note: '包含多个关卡，将按顺序执行',
            autoAddS: !hasS,
            copilots,
            currentIndex: 0
          })
          restoreSelectedCopilots(copilotId, copilots, raid)
          setStatusMessage(`已加载作业集：${copilots.length} 个作业`)
        } else {
          setStatusMessage('作业集不存在或为空')
        }
      } else {
        // 自动检测模式：同时请求两个接口，哪个成功就用哪个
        const [copilotResult, setResult] = await Promise.allSettled([
          getCopilotInfo(copilotId),
          getCopilotSet(copilotId)
        ])
        if (!isCurrentRequest()) return

        let foundSingle = false
        let foundSet = false
        let singleData: any = null
        let setData: any = null

        // 检查单个作业
        if (copilotResult.status === 'fulfilled') {
          const content = getCopilotContent(copilotResult.value)
          if (content) {
            foundSingle = true
            singleData = content
          }
        }

        // 检查作业集
        if (setResult.status === 'fulfilled') {
          const copilotIds = getCopilotSetIds(setResult.value)
          if (copilotIds.length > 0) {
            foundSet = true
            setData = copilotIds
          }
        }

        // 根据结果决定使用哪个
        if (foundSingle && foundSet) {
          // 两个都存在，优先使用作业集（因为作业集更少见，用户可能更想要）
          const copilotIds: number[] = setData
          const copilots = await Promise.all(copilotIds.map(id => fetchCopilotDetail(id)))
          if (!isCurrentRequest()) return
          const validCopilots = copilots.filter((item): item is CopilotSetItem => item !== null)
          setCopilotSetInfo({
            type: 'set',
            id: copilotId,
            name: `作业集 (${validCopilots.length} 个作业)`,
            note: '包含多个关卡，将按顺序执行',
            autoAddS: !hasS,
            copilots: validCopilots,
            currentIndex: 0
          })
          restoreSelectedCopilots(copilotId, validCopilots, raid)
          setStatusMessage(`已识别作业集：${validCopilots.length} 个作业`)
        } else if (foundSet) {
          // 只有作业集
          const copilotIds: number[] = setData
          const copilots = await Promise.all(copilotIds.map(id => fetchCopilotDetail(id)))
          if (!isCurrentRequest()) return
          const validCopilots = copilots.filter((item): item is CopilotSetItem => item !== null)
          setCopilotSetInfo({
            type: 'set',
            id: copilotId,
            name: `作业集 (${validCopilots.length} 个作业)`,
            note: '包含多个关卡，将按顺序执行',
            autoAddS: !hasS,
            copilots: validCopilots,
            currentIndex: 0
          })
          restoreSelectedCopilots(copilotId, validCopilots, raid)
          setStatusMessage(`已加载作业集：${validCopilots.length} 个作业`)
        } else if (foundSingle) {
          // 只有单个作业
          const content = singleData
          setCopilotSetInfo({
            type: 'single',
            id: copilotId,
            name: content.doc?.title || '未命名作业',
            stage: content.stage_name,
            operators: extractOperators(content)
          })
          setStatusMessage(`已加载作业：${content.doc?.title || content.stage_name}`)
        } else {
          const singlePayload = copilotResult.status === 'fulfilled' ? unwrapApiPayload(copilotResult.value) : null
          const setPayload = setResult.status === 'fulfilled' ? unwrapApiPayload(setResult.value) : null
          const looksLikeSetFallback = singlePayload?.status_code === 404 && setPayload?.status_code === 400

          if (looksLikeSetFallback) {
            setCopilotSetInfo({
              type: 'set',
              id: copilotId,
              name: '作业集',
              note: `当前接口未返回 ${copilotId} 的明细，执行时将按作业集处理${!hasS ? '（自动添加 s 前缀）' : ''}`,
              autoAddS: !hasS,
              copilots: [],
              currentIndex: 0
            })
            applySelectedCopilotIndexes(new Set(), copilotId)
            setStatusMessage(`已按作业集处理：prts://s${copilotId}${!hasS ? '（执行时自动添加 s 前缀）' : ''}`)
          } else {
            setStatusMessage('未找到作业或作业集')
          }
        }
      }

    } catch (error) {
      if (isCurrentRequest()) setStatusMessage(`网络错误: ${(error as Error).message}`)
    } finally {
      if (isCurrentRequest()) setIsLoadingSet(false)
    }
  }

  // 搜索悖论模拟作业
  const handleSearchParadox = async () => {
    if (isSearchingParadox) return
    if (!paradoxSearchName.trim()) {
      setStatusMessage('请输入干员名字')
      return
    }

    const requestId = ++paradoxSearchRequestRef.current
    const query = paradoxSearchName.trim()
    setIsSearchingParadox(true)
    setStatusMessage('正在搜索作业...')
    setParadoxSearchResult(null)

    try {
      const result = await searchParadoxCopilot(query)
      if (paradoxSearchRequestRef.current !== requestId) return

      // 适配新的响应格式：数据在 result.data 中
      const data = result.data || result

      if (result.success && data.copilots && data.copilots.length > 0) {
        setParadoxSearchResult(data)
        setStatusMessage(`找到 ${data.copilots.length} 个作业`)

        // 自动填充推荐作业
        if (data.recommended) {
          updateCombatConfig(current => ({
            ...current,
            taskInputs: { ...current.taskInputs, paradoxcopilot: data.recommended.uri },
          }))
        }
      } else {
        setStatusMessage(result.message || data.error || '未找到作业')
        setParadoxSearchResult(null)
      }
    } catch (error) {
      if (paradoxSearchRequestRef.current !== requestId) return
      setStatusMessage(`搜索失败: ${(error as Error).message}`)
      setParadoxSearchResult(null)
    } finally {
      if (paradoxSearchRequestRef.current === requestId) setIsSearchingParadox(false)
    }
  }

  // 搜索普通关卡作业
  const handleSearchCopilot = async () => {
    if (isSearchingCopilot) return
    if (!copilotSearchStage.trim()) {
      setStatusMessage('请输入关卡名称')
      return
    }

    const requestId = ++copilotSearchRequestRef.current
    const query = copilotSearchStage.trim()
    setIsSearchingCopilot(true)
    setStatusMessage('正在搜索作业...')
    setCopilotSearchResult(null)

    try {
      const result = await searchCopilot(query)
      if (copilotSearchRequestRef.current !== requestId) return

      // 适配新的响应格式：数据在 result.data 中
      const data = result.data || result

      if (result.success && data.copilots && data.copilots.length > 0) {
        setCopilotSearchResult(data)

        // 自动填充并预览推荐作业
        if (data.recommended?.uri) {
          await applyCopilotUri(data.recommended.uri)
        } else {
          setStatusMessage(`找到 ${data.copilots.length} 个作业`)
        }
      } else {
        setStatusMessage(result.message || data.error || '未找到作业')
        setCopilotSearchResult(null)
      }
    } catch (error) {
      if (copilotSearchRequestRef.current !== requestId) return
      setStatusMessage(`搜索失败: ${(error as Error).message}`)
      setCopilotSearchResult(null)
    } finally {
      if (copilotSearchRequestRef.current === requestId) setIsSearchingCopilot(false)
    }
  }

  const handleCopilotSearchStageChange = (value: string) => {
    copilotSearchRequestRef.current += 1
    setIsSearchingCopilot(false)
    setCopilotSearchStage(value)
  }

  const handleParadoxSearchNameChange = (value: string) => {
    paradoxSearchRequestRef.current += 1
    setIsSearchingParadox(false)
    setParadoxSearchName(value)
  }

  const handleCopilotTypeChange = (type: 'auto' | 'single' | 'set') => {
    previewRequestRef.current += 1
    setIsLoadingSet(false)
    setCopilotType(type)
  }


  const renderAdvancedOptions = (task: CombatTask) => {
    const options = getAdvancedOptions(task.id)
    if (options.length === 0) return null

    const advanced = advancedParams[task.id] || {}

    return (
      <motion.div
        className="mt-3 space-y-3 border-t border-(--app-border) pt-3"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        transition={{ duration: 0.3 }}
      >
        {options.map(option => {
          const controlId = `combat-${task.id}-${option.key}`
          return (
          <div key={option.key} className="min-w-0">
            {option.type === 'checkbox' ? (
              <label htmlFor={controlId} className="group flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 py-2 text-sm text-secondary">
                <input
                  id={controlId}
                  type="checkbox"
                  checked={advanced[option.key] as boolean || false}
                  onChange={(e) => handleAdvancedChange(task.id, option.key, e.target.checked)}
                  className="custom-checkbox h-4 w-4 cursor-pointer"
                />
                <span className="min-w-0 truncate transition-colors group-hover:text-(--app-accent)">{option.label}</span>
              </label>
            ) : option.type === 'select' && option.options ? (
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
                <label htmlFor={controlId} className="text-sm text-secondary">{option.label}</label>
                <select
                  id={controlId}
                  name={`maa-${task.id}-${option.key}`}
                  value={(advanced[option.key] as string) || (option.options[0]?.value || '')}
                  onChange={(e) => handleAdvancedChange(task.id, option.key, e.target.value)}
                  className="app-input app-native-control min-h-11 min-w-0 control-surface"
                >
                  {option.options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
                <label htmlFor={controlId} className="text-sm text-secondary">{option.label}</label>
                <input
                  id={controlId}
                  type={option.type}
                  name={`maa-${task.id}-${option.key}`}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={advanced[option.key] as string || ''}
                  onChange={(e) => handleAdvancedChange(task.id, option.key, e.target.value)}
                  placeholder={option.placeholder}
                  className="app-input app-native-control min-h-11 min-w-0 control-surface"
                />
              </div>
            )}
          </div>
          )
        })}
      </motion.div>
    )
  }

  const combatModeOptions = [
    { id: 'copilot' as const, title: '普通作业', desc: '单作业 / 作业集 / 链接识别', icon: <Icons.Document /> },
    { id: 'ssscopilot' as const, title: '保全派驻', desc: '保全派驻自动执行', icon: <Icons.Shield /> },
    { id: 'paradoxcopilot' as const, title: '悖论模拟', desc: '按干员搜索作业', icon: <Icons.Puzzle /> },
  ]

  return (
    <>
      <div className="app-page combat-page ios-workspace-page" data-workbench-tasks>
        <div className="app-stack-section">
        <PageHeader
          title="自动战斗"
          subtitle="支持单作业、作业集、保全派驻、悖论模拟与链接识别"
          mobileLayout="inline"
          actions={<FloatingStatusIndicator />}
        />

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
        <div className="app-workspace-segments app-liquid-tab-pill combat-mode-shell">
          <div
            ref={combatModeTabsRef}
            className="app-workspace-segment-list"
            role="toolbar"
            aria-label="作业类型"
          >
            {activeCombatModeRect.width > 0 && (
              <motion.div
                data-testid="combat-mode-highlight"
                aria-hidden="true"
                className="app-workspace-segment-indicator combat-mode-highlight"
                initial={false}
                animate={{
                  x: activeCombatModeRect.x,
                  y: activeCombatModeRect.y,
                  width: activeCombatModeRect.width,
                  height: activeCombatModeRect.height,
                }}
                transition={shouldReduceMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
              />
            )}
            {combatModeOptions.map(({ id, title, desc, icon }) => (
              <button
                key={id}
                ref={(element) => {
                  setCombatModeTabRef(id)(element)
                }}
                type="button"
                onClick={() => setActiveCombatMode(id)}
                onKeyDown={(event) => handleCombatModeKeyDown(
                  event,
                  combatModeOptions.map(option => option.id),
                  setActiveCombatMode,
                )}
                aria-pressed={activeCombatMode === id}
                tabIndex={activeCombatMode === id ? 0 : -1}
                className={`app-workspace-segment combat-mode-button min-h-11 ${activeCombatMode === id ? 'is-selected' : ''}`}
              >
                <span className="app-workspace-segment-icon combat-mode-icon">
                  {icon}
                </span>
                <span className="app-workspace-segment-copy">
                  <span>{title}</span>
                  <small>{desc}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 任务列表 */}
        <div className="app-stack-section">
          {/* 自动抄作业 - 单独一行 */}
          {activeCombatMode === 'copilot' && tasks.filter(task => task.id === 'copilot').map((task) => {
            return (
              <Card
                key={task.id}
                smoothCorners
                className="combat-task-card p-0!"
              >
                <div className="combat-task-heading flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="combat-task-icon">
                      {task.icon}
                    </div>
                    <div className="min-w-0">
                      <h4 className="truncate text-lg font-semibold text-primary">{task.name}</h4>
                      <p className="mt-1 text-sm leading-relaxed text-secondary">{task.description}</p>
                    </div>
                  </div>

                  {isRunning ? (
                    <Button
                      onClick={handleStopTask}
                      disabled={isStopping}
                      loading={isStopping}
                      loadingText="正在终止"
                      variant="danger"
                      size="md"
                      icon={!isStopping ? <Square size={14} fill="currentColor" aria-hidden="true" /> : undefined}
                      className="combat-task-run-button min-h-11 px-4 text-sm sm:px-6"
                    >
                      终止执行
                    </Button>
                  ) : (
                    <Button
                      onClick={() => handleExecute(task)}
                      disabled={!automationAvailable}
                      loading={isSubmitting}
                      loadingText="正在启动"
                      title={!automationAvailable ? unavailableMessage : undefined}
                      variant="primary"
                      size="md"
                      icon={<Play size={15} fill="currentColor" aria-hidden="true" />}
                      className="combat-task-run-button min-h-11 px-4 text-sm sm:px-6"
                    >
                      立即执行
                    </Button>
                  )}
                </div>

                {/* 作业配置区 */}
                <div className="combat-copilot-layout">
                  {/* 左栏：设置项 */}
                  <div className="space-y-3 xl:sticky xl:top-4">
                    <div className="combat-workspace-section">
                      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
                        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>执行设置</span>
                      </h5>

                      {/* 自动编队 */}
                      <div className="mb-3 space-y-1.5">
                        <div className="flex items-center space-x-2">
                          <label htmlFor="combat-copilot-formation" className="w-12 shrink-0 text-xs text-secondary">编队</label>
                          <select
                            id="combat-copilot-formation"
                            name="maa-copilot-formation"
                            value={getFormationMode(task.id)}
                            onChange={(e) => updateCombatConfig(current => ({
                              ...current,
                              autoFormation: { ...current.autoFormation, [task.id]: e.target.value as FormationMode },
                            }))}
                            className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
                          >
                            <option value="auto">自动决定</option>
                            <option value="on">自动编队</option>
                            <option value="off">保留当前编队</option>
                          </select>
                        </div>
                        <p className="pl-14 text-xs leading-relaxed text-tertiary">
                          作业集拆分执行时，“自动决定”会启用自动编队；单作业会使用默认设置。
                        </p>
                      </div>

                      {/* 突袭模式 */}
                      <div className="mb-3 flex items-center space-x-2">
                        <label htmlFor="combat-copilot-raid" className="w-12 shrink-0 text-xs text-secondary">模式</label>
                        <select
                          id="combat-copilot-raid"
                          name="maa-copilot-raid"
                          value={normalizeRaidValue(advancedParams[task.id]?.raid)}
                          onChange={(e) => handleAdvancedChange(task.id, 'raid', e.target.value)}
                          className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
                        >
                          <option value="normal">普通模式</option>
                          <option value="raid">突袭模式</option>
                          <option value="both">普通+突袭</option>
                        </select>
                      </div>

                      {/* 作业集执行方式 */}
                      <div className="space-y-1.5">
                        <div className="flex items-center space-x-2">
                          <label htmlFor="combat-copilot-set-mode" className="w-12 shrink-0 text-xs text-secondary">作业集</label>
                          <select
                            id="combat-copilot-set-mode"
                            name="maa-copilot-set-mode"
                            value={copilotSetExecutionMode}
                            onChange={(e) => updateCombatConfig(current => ({
                              ...current,
                              copilotSetExecutionMode: e.target.value as CopilotSetExecutionMode,
                            }))}
                            className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
                          >
                            <option value="app">顺序执行</option>
                            <option value="manual">手动逐关</option>
                            <option value="cli">连续执行</option>
                          </select>
                        </div>
                        <p className="pl-14 text-xs leading-relaxed text-tertiary">
                          顺序执行会保存进度：成功项自动移出待执行，失败项保留待重试。
                        </p>
                      </div>

                      {/* 高级选项 */}
                      {task.hasAdvanced && (
                        <details className="combat-advanced-disclosure mt-4">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-medium text-secondary">
                            高级设置
                          </summary>
                          {renderAdvancedOptions(task)}
                        </details>
                      )}
                    </div>
                  </div>

                  {/* 中栏：输入框 + 作业列表 */}
                  <div className="flex min-w-0 flex-col space-y-3">
                    <div className="combat-workspace-section">
                      <div className="flex gap-2">
                        <label htmlFor="combat-copilot-uri" className="sr-only">作业链接或本地路径</label>
                        <input
                          id="combat-copilot-uri"
                          type="text"
                          name="maa-copilot-uri"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          inputMode="url"
                          placeholder="prts://1234、prts://s1234、作业站链接或本地路径"
                          value={taskInputs[task.id] || ''}
                          onChange={(e) => handleInputChange(task.id, e.target.value)}
                          className="app-input app-native-control min-h-11 min-w-0 flex-1 font-mono control-surface"
                        />
                        <Button
                          onClick={() => handlePreviewCopilotSetWithInput()}
                          disabled={isLoadingSet || !taskInputs[task.id]?.trim()}
                          loading={isLoadingSet}
                          variant="secondary"
                          size="md"
                          className="shrink-0 px-3"
                          icon={
                            !isLoadingSet && (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            )
                          }
                        >
                          {!isLoadingSet && '预览'}
                        </Button>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-tertiary">
                        <p className="truncate">支持作业链接、导入文件和本地作业。</p>
                        <details className="group relative shrink-0">
                          <summary className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center brand-text hover:underline">说明</summary>
                          <div className="absolute right-0 z-20 mt-2 hidden w-[min(18rem,calc(100vw-3rem))] space-y-1.5 rounded-lg border border-(--app-border) bg-(--app-surface-solid) p-3 text-left shadow-lg group-open:block">
                            <p>• 在 <a href="https://prts.plus/" target="_blank" rel="noopener noreferrer" className="brand-text hover:underline">prts.plus</a> 获取作业链接</p>
                            <p>• 单作业：<code className="px-1 bg-gray-100 dark:bg-gray-800 rounded-sm">prts://1234</code>；作业集：<code className="px-1 bg-gray-100 dark:bg-gray-800 rounded-sm">prts://s1234</code></p>
                            <p>• 作业站链接会自动识别，也可导入远程或本地作业文件</p>
                          </div>
                        </details>
                      </div>
                    </div>

                    {/* 作业类型选择 */}
                    <div className="flex items-center justify-between gap-3 px-4 text-xs">
                      <span className="shrink-0 font-medium text-secondary">识别方式</span>
                      <div className="flex min-w-0 max-w-full overflow-hidden rounded-lg border border-(--app-border) bg-(--app-surface-muted) p-0.5">
                        <button
                          onClick={() => handleCopilotTypeChange('auto')}
                          className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
                            copilotType === 'auto'
                              ? 'combat-segment-active'
                              : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
                          }`}
                        >
                          自动
                        </button>
                        <button
                          onClick={() => handleCopilotTypeChange('single')}
                          className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
                            copilotType === 'single'
                              ? 'combat-segment-active'
                              : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
                          }`}
                        >
                          单个作业
                        </button>
                        <button
                          onClick={() => handleCopilotTypeChange('set')}
                          className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
                            copilotType === 'set'
                              ? 'combat-segment-active'
                              : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
                          }`}
                        >
                          作业集
                        </button>
                      </div>
                    </div>

                    {/* 作业列表 - 占据剩余空间 */}
                    <div className="combat-workspace-section combat-job-list-section flex flex-1 flex-col">
                      <div className="flex items-center justify-between mb-3">
                        <h5 className="flex items-center space-x-2 text-sm font-semibold text-primary">
                          <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                          </svg>
                          <span>作业列表</span>
                        </h5>
                        {copilotSetInfo?.type === 'set' && copilotSetInfo.copilots && !isRunning && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setResetProgressDialogOpen(true)}
                              disabled={isResettingProgress}
                              className="min-h-11 px-1 text-xs text-gray-500 transition-colors hover:text-(--app-accent) disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400"
                            >
                              {isResettingProgress ? '重置中...' : '重置进度'}
                            </button>
                            <span className="h-3 w-px bg-gray-200 dark:bg-white/10" />
                            <button
                              onClick={() => {
                                if (selectedCopilotIndexes.size === copilotSetInfo.copilots!.length) {
                                  applySelectedCopilotIndexes(new Set(), copilotSetInfo.id)
                                } else {
                                  applySelectedCopilotIndexes(new Set(copilotSetInfo.copilots!.map((_, idx) => idx)), copilotSetInfo.id)
                                }
                              }}
                              className="min-h-11 px-1 text-xs brand-text transition-colors hover:underline"
                            >
                              {selectedCopilotIndexes.size === copilotSetInfo.copilots.length ? '清空待执行' : '全选待执行'}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* 作业集预览 */}
                      {copilotSetInfo?.type === 'set' && copilotSetInfo.copilots && copilotSetInfo.copilots.length > 0 ? (
                        <>
                          {(() => {
                            const total = copilotSetInfo.copilots.length
                            const pendingCount = pendingSelectedCount
                            const completedCount = total - pendingCount
                            const failedCount = setRunFailedCount
                            const nextIndex = resumeIndex
                            const nextCopilot = nextIndex >= 0 ? copilotSetInfo.copilots[nextIndex] : null
                            return (
                              <div className="mb-3 border-y border-(--app-border) py-3">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium text-tertiary">续跑进度</div>
                                    <div className="mt-1 text-sm font-semibold text-primary">
                                      {nextCopilot ? `下次从第 ${nextIndex + 1} 关继续` : '作业集已完成'}
                                    </div>
                                    <div className="mt-1 truncate text-xs text-tertiary">
                                      {setRunAttemptedCount > 0 ? `本次已执行 ${setRunAttemptedCount} 个` : `共 ${total} 个作业`}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <span className="rounded-md px-2 py-1 text-[11px] brand-chip">待 {pendingCount}</span>
                                    <span className="rounded-md border border-(--app-border) px-2 py-1 text-[11px] text-secondary">完成 {completedCount}</span>
                                    <span className={`rounded-md border px-2 py-1 text-[11px] ${failedCount > 0 ? 'border-rose-400/30 bg-rose-500/10 text-rose-500 dark:text-rose-300' : 'border-(--app-border) text-secondary'}`}>失败 {failedCount}</span>
                                  </div>
                                </div>
                                <div className="mt-3">
                                  <div className="h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                                    <div
                                      className="h-full bg-(--app-accent) transition-all duration-300"
                                      style={{ width: `${total > 0 ? (completedCount / total) * 100 : 0}%` }}
                                    />
                                  </div>
                                  {nextCopilot ? (
                                    <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-(--app-border) pt-2 text-xs">
                                      <span className="shrink-0 text-tertiary">续跑目标</span>
                                      <span className="font-mono brand-text">prts://{nextCopilot.id}</span>
                                      <span className="min-w-0 truncate text-secondary">{nextCopilot.stage || nextCopilot.name || `第 ${nextIndex + 1} 关`}</span>
                                    </div>
                                  ) : (
                                    <div className="mt-2 border-t border-(--app-border) pt-2 text-xs text-tertiary">
                                      需要重打时点击“重置进度”。
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })()}

                          {/* 下一关卡片：等待态与下一项由服务端 run 持有 */}
                          {waitingEntry && (
                            <div className="mb-3 rounded-lg border border-(--app-accent) bg-(--app-accent-soft) p-3">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center space-x-2">
                                  <span className="px-2 py-0.5 brand-action text-xs font-medium rounded-sm">下一关</span>
                                  <span className="text-xs brand-text">第 {(waitingEntryIndex ?? 0) + 1} / {Math.max(copilotSetInfo.copilots.length, activeSetRun?.itemCount ?? 0)} 关</span>
                                </div>
                                <span className="font-mono text-xs brand-text">prts://{waitingCopilot?.id ?? waitingEntry.copilotId}</span>
                              </div>
                              <p className="text-sm font-medium text-primary">{waitingCopilot?.name || `作业 #${waitingEntry.copilotId ?? ''}`}</p>
                              {(waitingCopilot?.stage || waitingEntry.stage) && (
                                <p className="text-xs text-secondary">{waitingCopilot?.stage || waitingEntry.stage}</p>
                              )}

                              <div className="mt-3 pt-3 border-t border-(--app-border)">
                                <p className="text-xs brand-text mb-2">请在游戏中进入下一关界面后点击继续</p>
                                <div className="flex space-x-2">
                                  <Button
                                    onClick={handleStartNextCopilot}
                                    disabled={!automationAvailable || isContinuing}
                                    loading={isContinuing}
                                    loadingText="正在开始"
                                    title={!automationAvailable ? unavailableMessage : undefined}
                                    variant="primary"
                                    size="md"
                                    fullWidth
                                  >
                                    开始下一关
                                  </Button>
                                  <Button onClick={handleCancelCopilotSet} variant="secondary" size="md">取消</Button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* 作业列表 */}
                          <div className="flex-1 divide-y divide-(--app-border) overflow-hidden overflow-y-auto rounded-lg border border-(--app-border) bg-(--app-surface-solid)">
                            {copilotSetInfo.copilots.map((copilot, idx) => {
                              const runStatus = setItemStatus(idx)
                              const isCompleted = runStatus === 'success' || runStatus === 'failed' || runStatus === 'stopped'
                              const isSuccess = runStatus === 'success'
                              const isCurrent = runStatus === 'running'
                              const isSelected = selectedCopilotIndexes.has(idx)
                              const isPersistedDone = !isSelected && !isCompleted
                              const statusLabel = isCurrent
                                ? '执行中'
                                : isCompleted
                                  ? (isSuccess ? '已完成' : '待重试')
                                  : isPersistedDone
                                    ? '已完成/跳过'
                                    : '待执行'

                              const handleToggleSelect = () => {
                                const newSet = new Set(selectedCopilotIndexes)
                                if (newSet.has(idx)) {
                                  newSet.delete(idx)
                                } else {
                                  newSet.add(idx)
                                }
                                applySelectedCopilotIndexes(newSet, copilotSetInfo.id)
                              }

                              return (
                                <div key={`${copilot.id}-${idx}`} className={`flex items-center justify-between gap-3 px-2.5 py-2 text-xs transition-colors ${
                                  isCurrent ? 'bg-(--app-accent-soft)' :
                                  isCompleted ? (isSuccess ? 'bg-emerald-500/10' : 'bg-rose-500/10') :
                                  isPersistedDone ? 'bg-black/2.5 opacity-70 dark:bg-white/[0.035]' :
                                  'hover:bg-(--app-surface-muted)'
                                }`}>
                                  <div className="flex min-w-0 items-center space-x-2">
                                    {/* 勾选框 */}
                                    <button
                                      type="button"
                                      onClick={handleToggleSelect}
                                      disabled={isRunning}
                                      aria-pressed={isSelected}
                                      aria-label={`${isSelected ? '取消选择' : '选择'}第 ${idx + 1} 个作业`}
                                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors ${isRunning ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-(--app-accent-soft)'}`}
                                    >
                                      <span className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                                          isSelected
                                            ? 'border-(--app-accent) bg-(--app-accent) text-white'
                                            : 'border-(--app-border-strong) bg-(--app-surface-solid)'
                                        }`}>
                                        {isSelected && (
                                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                          </svg>
                                        )}
                                      </span>
                                    </button>
                                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                                      isCurrent ? 'bg-(--app-accent) text-white animate-pulse' :
                                      isCompleted ? (isSuccess ? 'bg-(--app-success) text-white' : 'bg-(--app-danger) text-white') :
                                      isPersistedDone ? 'bg-black/10 text-tertiary dark:bg-white/10' :
                                      'bg-black/5 text-secondary dark:bg-white/10'
                                    }`}>
                                      {isCompleted ? (isSuccess ? '✓' : '✗') : isPersistedDone ? '✓' : idx + 1}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="truncate text-primary">{copilot.name || `作业 #${copilot.id}`}</span>
                                        {copilot.presetFormation && (
                                          <span className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] brand-chip">预设编队 · 仅普通</span>
                                        )}
                                        {copilot.completedModes?.map(mode => (
                                          <span key={mode} className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                                            {mode === 'raid' ? '突袭已完成' : '普通已完成'}
                                          </span>
                                        ))}
                                      </div>
                                      {copilot.stage && <div className="mt-0.5 truncate text-xs text-tertiary">{copilot.stage}</div>}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <span className={`min-w-[64px] rounded-md px-2 py-0.5 text-center text-[11px] ${
                                      isCurrent ? 'brand-action text-white' :
                                      isCompleted && !isSuccess ? 'bg-rose-500/10 text-rose-500 dark:text-rose-300' :
                                      isSelected ? 'brand-chip' :
                                      'bg-black/5 text-secondary dark:bg-white/10'
                                    }`}>
                                      {statusLabel}
                                    </span>
                                    <span className="hidden font-mono text-tertiary 2xl:inline">prts://{copilot.id}</span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </>
                      ) : copilotSetInfo?.type === 'single' ? (
                        <div className="flex-1 border-y border-(--app-border) py-3">
                          <div className="flex items-center space-x-2 mb-1">
                            <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">单个作业</span>
                            <span className="text-xs text-tertiary">ID: {copilotSetInfo.id}</span>
                          </div>
                          <p className="font-medium text-primary">{copilotSetInfo.name}</p>
                          <div className="mt-1 space-x-2 text-xs text-secondary">
                            {copilotSetInfo.stage && <span>关卡: {copilotSetInfo.stage}</span>}
                            {copilotSetInfo.operators && <span>干员: {copilotSetInfo.operators}</span>}
                          </div>
                        </div>
                      ) : (
                        <EmptyState
                          compact
                          className="combat-job-empty flex-1"
                          icon={<FileText size={24} strokeWidth={1.7} />}
                          title="等待作业"
                          description="输入作业链接即可预览，本地作业可直接执行。"
                        />
                      )}
                    </div>
                  </div>

                  {/* 右栏：搜索框 + 作业介绍 */}
                  <div className="space-y-3 xl:sticky xl:top-4">
                    {/* 搜索框 */}
                    <div className="combat-workspace-section">
                      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
                        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <span>快速搜索</span>
                      </h5>
                      <div className="flex space-x-2">
                        <label htmlFor="combat-stage-search" className="sr-only">搜索关卡作业</label>
                        {/* v4 的 space-x 只给非末子元素加 end margin；补回 sr-only label 参与计数时的 v3 左间距 */}
                        <input
                          id="combat-stage-search"
                          type="text"
                          name="maa-copilot-stage-search"
                          placeholder="关卡名称，如：1-7、CE-6"
                          value={copilotSearchStage}
                          onChange={(e) => handleCopilotSearchStageChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' || isSearchingCopilot || !copilotSearchStage.trim()) return
                            e.preventDefault()
                            void handleSearchCopilot()
                          }}
                          className="app-input app-native-control min-h-11 min-w-0 flex-1 ml-2 control-surface"
                        />
                        <Button
                          onClick={handleSearchCopilot}
                          disabled={isSearchingCopilot || !copilotSearchStage.trim()}
                          loading={isSearchingCopilot}
                          variant="secondary"
                          size="md"
                          className="px-3"
                        >
                          {!isSearchingCopilot && '搜索'}
                        </Button>
                      </div>
                      <p className="mt-2 text-xs text-tertiary">支持关卡代号或关卡名，例如 1-7、CE-6。</p>

                      {/* 搜索结果 */}
                      {copilotSearchResult && copilotSearchResult.copilots && (
                        <div className="mt-3 max-h-32 space-y-1 overflow-y-auto">
                          {copilotSearchResult.copilots.slice(0, 5).map((copilot, idx) => (
                            <button
                              key={copilot.id}
                              onClick={() => void applyCopilotUri(copilot.uri)}
                              className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-1.5 text-left text-xs transition-all ${
                                selectedSearchCopilotUri === copilot.uri
                                  ? 'brand-action-subtle border-(--app-accent)'
                                  : 'border-(--app-border) bg-(--app-surface) hover:border-(--app-accent)'
                              }`}
                            >
                              <div className="flex items-center space-x-2">
                                <span className="font-mono brand-text">{copilot.uri}</span>
                                <span className="max-w-20 truncate text-secondary">{copilot.title}</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {selectedSearchCopilotUri === copilot.uri && (
                                  <span className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs brand-chip">已选中</span>
                                )}
                                {idx === 0 && (
                                  <span className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs brand-chip">推荐</span>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 作业介绍 */}
                    <div className="combat-workspace-section">
                      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
                        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>作业信息</span>
                      </h5>

                      {copilotSetInfo ? (
                        <div className="space-y-2">
                          {copilotSetInfo.type === 'set' && copilotSetInfo.copilots ? (
                            (() => {
                              // 作业集模式：显示当前作业，或接下来要执行的作业
                              const panelIndex = runCurrentIndex ?? (resumeIndex >= 0 ? resumeIndex : 0)
                              const currentCopilot = copilotSetInfo.copilots[panelIndex] || copilotSetInfo.copilots[0]
                              const total = copilotSetInfo.copilots.length
                              const selectedCount = selectedCopilotIndexes.size
                              const completed = Math.max(0, selectedCount - pendingSelectedCount)

                              return (
                                <>
                                  <div className="flex items-center space-x-2">
                                    <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">作业集</span>
                                    <span className="text-xs text-tertiary">已选 {selectedCount}/{total} 个</span>
                                  </div>

                                  {/* 当前进度 */}
                                  <div className="flex items-center space-x-2 text-xs">
                                    <span className="text-tertiary">进度</span>
                                    <span className="font-medium brand-text">
                                      {isRunning ? `第 ${panelIndex + 1} 关` : `${completed}/${selectedCount} 完成`}
                                    </span>
                                  </div>

                                  {/* 当前作业详情 */}
                                  {currentCopilot && (
                                    <div className="border-t border-(--app-border) pt-2">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-tertiary">
                                          {isRunning ? '当前作业' : '下一作业'}
                                        </span>
                                        <span className="font-mono text-xs brand-text">
                                          prts://{currentCopilot.id}
                                        </span>
                                      </div>
                                      <p className="text-sm font-medium text-primary">
                                        {currentCopilot.name || `作业 #${currentCopilot.id}`}
                                      </p>
                                      {currentCopilot.stage && (
                                        <div className="mt-1 text-xs text-secondary">
                                          <span className="font-medium">关卡:</span> {currentCopilot.stage}
                                        </div>
                                      )}
                                      {currentCopilot.operators && (
                                        <div className="text-xs text-secondary">
                                          <span className="font-medium">干员:</span> {currentCopilot.operators}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {copilotSetInfo.note && (
                                    <p className="text-xs text-tertiary">{copilotSetInfo.note}</p>
                                  )}
                                </>
                              )
                            })()
                          ) : (
                            <>
                              <div className="flex items-center space-x-2">
                                <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">单个作业</span>
                                <span className="text-xs text-tertiary">ID: {copilotSetInfo.id}</span>
                              </div>
                              <p className="text-sm font-medium text-primary">{copilotSetInfo.name}</p>
                              {copilotSetInfo.stage && (
                                <div className="text-xs text-secondary">
                                  <span className="font-medium">关卡:</span> {copilotSetInfo.stage}
                                </div>
                              )}
                              {copilotSetInfo.operators && (
                                <div className="text-xs text-secondary">
                                  <span className="font-medium">干员:</span> {copilotSetInfo.operators}
                                </div>
                              )}
                            </>
                          )}
                          <Button
                            onClick={() => setCopilotSetInfo(null)}
                            variant="ghost"
                            size="sm"
                            className="mt-2 text-xs"
                          >
                            清除预览
                          </Button>
                        </div>
                      ) : (
                        <EmptyState
                          compact
                          icon={<Info size={22} strokeWidth={1.7} />}
                          title="等待预览"
                          description="预览作业后会在这里显示详情。"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            )
          })}

          {/* 保全派驻 / 悖论模拟 */}
          <div className="app-stack-section">
            {tasks.filter(task => task.id === activeCombatMode && task.id !== 'copilot').map((task) => {
              const taskUris = splitCopilotInputToArgs(taskInputs[task.id] || '')
              const isParadox = task.id === 'paradoxcopilot'
              const isSss = task.id === 'ssscopilot'
              const recommendedParadox = paradoxSearchResult?.copilots?.[0]

              return (
                <Card
                  key={task.id}
                  smoothCorners
                  className="combat-task-card p-0!"
                >
                  <div className="combat-task-heading flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="combat-task-icon">
                        {task.icon}
                      </div>
                      <div className="min-w-0">
                        <h4 className="truncate text-lg font-semibold text-primary">{task.name}</h4>
                        <p className="mt-1 text-sm leading-relaxed text-secondary">{task.description}</p>
                      </div>
                    </div>

                    {isRunning ? (
                      <Button
                        onClick={handleStopTask}
                        disabled={isStopping}
                        loading={isStopping}
                        loadingText="正在终止"
                        variant="danger"
                        size="md"
                        icon={!isStopping ? <Square size={14} fill="currentColor" aria-hidden="true" /> : undefined}
                        className="combat-task-run-button min-h-11 px-4 text-sm sm:px-5"
                      >
                        终止执行
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleExecute(task)}
                        disabled={!automationAvailable}
                        loading={isSubmitting}
                        loadingText="正在启动"
                        title={!automationAvailable ? unavailableMessage : undefined}
                        variant="primary"
                        size="md"
                        icon={<Play size={15} fill="currentColor" aria-hidden="true" />}
                        className="combat-task-run-button min-h-11 px-4 text-sm sm:px-5"
                      >
                        立即执行
                      </Button>
                    )}
                  </div>

                  <div className="combat-special-layout">
                    <div className="min-w-0 space-y-4">
                      <div className="combat-workspace-section">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <h5 className="flex items-center gap-2 text-sm font-semibold text-primary">
                            <svg className="h-4 w-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span>作业输入</span>
                          </h5>
                          <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${isSss && taskUris.length > 1 ? 'bg-rose-500/10 text-rose-500 dark:text-rose-300' : 'brand-chip'}`}>
                            {isSss ? `${taskUris.length}/1 URI` : `${taskUris.length} 个 URI`}
                          </span>
                        </div>
                        <label htmlFor={`combat-${task.id}-uris`} className="sr-only">
                          {task.name}作业链接或本地路径
                        </label>
                        <textarea
                          id={`combat-${task.id}-uris`}
                          name={`maa-${task.id}-uris`}
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder={
                            isSss
                              ? `${task.placeholder}\n一次只支持一个 SSS 作业 URI`
                              : `${task.placeholder}\n支持多行，每行一个作业 URI`
                          }
                          value={taskInputs[task.id] || ''}
                          onChange={(e) => handleInputChange(task.id, e.target.value)}
                          rows={isSss ? 4 : 5}
                          className="app-native-control w-full resize-none rounded-lg px-4 py-3 font-mono text-sm font-medium text-primary control-surface focus:outline-hidden focus:ring-2 focus:ring-(--app-accent-soft)"
                        />
                        {isSss && taskUris.length > 1 && (
                          <div className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-500 dark:text-rose-300">
                            保全派驻当前只会执行一个 SSS 作业 URI。
                          </div>
                        )}
                      </div>

                      {task.hasAdvanced && (
                        <div className="combat-workspace-section">
                          <h5 className="mb-2 text-sm font-semibold text-primary">高级设置</h5>
                          {renderAdvancedOptions(task)}
                        </div>
                      )}
                    </div>

                    <div className="space-y-3 xl:sticky xl:top-4">
                      {isParadox ? (
                        <div className="combat-workspace-section">
                          <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
                            <svg className="h-4 w-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <span>干员搜索</span>
                          </h5>
                          <div className="flex space-x-2">
                            <label htmlFor="combat-paradox-operator" className="sr-only">搜索悖论模拟干员</label>
                            <input
                              id="combat-paradox-operator"
                              type="text"
                              name="maa-paradox-operator"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              placeholder="古米、能天使"
                              value={paradoxSearchName}
                              onChange={(e) => handleParadoxSearchNameChange(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' || isSearchingParadox || !paradoxSearchName.trim()) return
                                e.preventDefault()
                                void handleSearchParadox()
                              }}
                              className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
                            />
                            <Button
                              onClick={handleSearchParadox}
                              disabled={isSearchingParadox || !paradoxSearchName.trim()}
                              loading={isSearchingParadox}
                              variant="secondary"
                              size="md"
                              className="shrink-0 px-3"
                            >
                              {!isSearchingParadox && '搜索'}
                            </Button>
                          </div>

                          {paradoxSearchResult && paradoxSearchResult.copilots && (
                            <div className="mt-3 space-y-2">
                              <div className="flex items-center justify-between text-xs">
                                <span className="font-medium brand-text">{paradoxSearchResult.operator}</span>
                                <span className="text-tertiary">{paradoxSearchResult.copilots.length} 个作业</span>
                              </div>
                              <div className="max-h-56 divide-y divide-(--app-border) overflow-hidden overflow-y-auto rounded-lg border border-(--app-border) bg-(--app-surface-solid)">
                                {paradoxSearchResult.copilots.slice(0, 6).map((copilot, idx) => {
                                  const stars = Math.min(5, Math.max(1, Math.ceil(copilot.hotScore)))

                                  return (
                                    <button
                                      key={copilot.id}
                                      onClick={() => {
                                        updateCombatConfig(current => ({
                                          ...current,
                                          taskInputs: { ...current.taskInputs, paradoxcopilot: copilot.uri },
                                        }))
                                      }}
                                      className="min-h-11 w-full px-3 py-2 text-left text-xs transition-colors hover:bg-(--app-surface-muted) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--app-accent)"
                                    >
                                      <div className="flex min-w-0 items-center justify-between gap-2">
                                        <span className="truncate font-mono brand-text">{copilot.uri}</span>
                                        {idx === 0 && (
                                          <span className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium brand-chip">推荐</span>
                                        )}
                                      </div>
                                      <div className="mt-1 flex items-center space-x-2 text-secondary">
                                        <span>浏览 {copilot.views.toLocaleString()}</span>
                                        <span>/</span>
                                        <div className="flex items-center">
                                          {[...Array(stars)].map((_, i) => (
                                            <svg key={i} className="h-3 w-3 brand-text" fill="currentColor" viewBox="0 0 20 20">
                                              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                            </svg>
                                          ))}
                                        </div>
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="combat-workspace-section">
                          <h5 className="mb-3 text-sm font-semibold text-primary">执行概览</h5>
                          <div className="divide-y divide-(--app-border) overflow-hidden rounded-lg border border-(--app-border) bg-(--app-surface-solid) text-xs">
                            <div className="flex items-center justify-between px-3 py-2">
                              <span className="text-tertiary">作业数量</span>
                              <span className={taskUris.length > 1 ? 'text-rose-500 dark:text-rose-300' : 'text-primary'}>{taskUris.length || 0}</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2">
                              <span className="text-tertiary">循环次数</span>
                              <span className="text-primary">{advancedParams.ssscopilot?.loopTimes || '1'}</span>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="combat-workspace-section">
                        <h5 className="mb-3 text-sm font-semibold text-primary">参数概览</h5>
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-tertiary">命令</span>
                            <span className="font-mono brand-text">{task.command}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-tertiary">输入</span>
                            <span className="text-primary">{taskUris.length ? `${taskUris.length} 项` : '待填写'}</span>
                          </div>
                          {isParadox && (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-tertiary">队列策略</span>
                              <span className="text-primary">
                                {advancedParams.paradoxcopilot?.executionStrategy === 'stop' ? '失败停止' : '失败继续'}
                              </span>
                            </div>
                          )}
                          {isParadox && recommendedParadox && (
                            <div className="rounded-lg border border-(--app-border) bg-(--app-surface) px-3 py-2">
                              <div className="mb-1 text-tertiary">当前推荐</div>
                              <div className="truncate font-mono brand-text">{recommendedParadox.uri}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
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
      </div>
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
