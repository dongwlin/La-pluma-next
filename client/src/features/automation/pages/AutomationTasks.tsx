import { useState, useEffect, useMemo, useRef } from 'react'
import { getErrorMessage, isRecord } from '@/shared/api'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, Cable, Check, CheckCircle2, ChevronDown, ChevronUp, CircleMinus, ClipboardList, Clock3, GripVertical, Info, ListPlus, LoaderCircle, Minus, Play, Plus, SlidersHorizontal, Square, Trash2 } from 'lucide-react'
import { ScreenMonitor } from '@/features/device-mirror'
import NotificationSettings from '../components/NotificationSettings'
import AutomationStageEditor from '../components/AutomationStageEditor'
import AutomationTaskPicker from '../components/AutomationTaskPicker'
import { AVAILABLE_TASKS } from '../components/automationTaskCatalog'
import { EmptyState, PageHeader, Button, IconButton, SmoothPanel, Switch } from '@/shared/ui'
import { FloatingStatusIndicator, useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import type {
  AutomationAvailableTask,
  TaskFlowItem,
  ConnectionTestStatus
} from '../types'
import { formatExecutionActionSummary } from '@/shared/utils/executionSummary'
import { getActivity } from '../api'
import { resolveExecutionStep, taskResultsFromSummary, type TaskExecutionResult } from '../utils/automationTaskProgress'
import { useAutomationExecution } from '../hooks/useAutomationExecution'
import {
  executionSummaryHasFailure,
  type AutomationExecutionSummary,
} from '../model/automationRun'
import {
  automationConfigAdapter,
  createDefaultAutomationDraft,
  toPersistedTaskFlow,
  toPersistedTaskFlowItem,
} from '../model/automationConfig'
import {
  MAX_SCHEDULE_ENTRIES,
  appendScheduleEntry,
  createDefaultScheduleEntries,
  normalizeScheduleEntries,
  parseScheduleTime,
  removeScheduleEntry,
  setScheduleEntryEnabled,
  updateScheduleTimeEntry,
  type ScheduleTimeEntry,
} from '../model/automationSchedule'
import {
  addTaskToFlow as appendTaskToFlow,
  findTaskFlowValidationFailure,
  insertTaskFlowItem,
  removeTaskFlowItem,
  toggleTaskFlowItemEnabled,
  updateTaskFlowParams,
} from '../model/taskFlowCommands'
import {
  getPointerSortTargetIndex,
  hasPointerSortActivated,
  moveTaskFlowItem,
} from '../model/taskFlowSort'
import {
  RECRUITMENT_TIME_MAX,
  RECRUITMENT_TIME_MIN,
  RECRUITMENT_TIME_STEP,
  normalizeRecruitmentTime,
} from '../model/taskParamRules'
import { useUserConfig } from '@/features/user-config'
import { useResourceInvalidation, type ResourceInvalidation } from '@/features/resource-invalidation'
import { testConnection as testAdbConnection } from '@/features/settings'

/** 养成为任务流程或定时配置发布失效；页面据此强制重读同一协调器通道。 */
const AUTOMATION_RESOURCE_SCOPES = ['automation-config', 'automation-schedule'] as const

interface PointerSortSession {
  pointerId: number
  startX: number
  startY: number
  itemId: string
  currentFlow: TaskFlowItem[]
  activated: boolean
  changed: boolean
}

interface DeletedTaskSnapshot {
  task: TaskFlowItem
  index: number
}

export default function AutomationTasks() {
  const shouldReduceMotion = useReducedMotion()
  const { setMessage: setStatusMessage } = useStatusStore()
  const { isAvailable: automationAvailable, unavailableMessage } = useAutomationAvailability()
  const {
    isRunning,
    isStopping,
    isSubmitting,
    progress: executionProgress,
    summary: executionSummary,
    scheduleSummary: executionScheduleSummary,
    submitFlow,
    stop: stopTaskFlow,
  } = useAutomationExecution({ notify: setStatusMessage })

  // 辅助函数：显示消息
  const showSuccess = (msg: string) => {
    setStatusMessage(msg, 'success')
  }
  const showError = (msg: string) => {
    setStatusMessage(msg, 'error')
  }

  const {
    draft: configDraft,
    syncState: configSyncState,
    error: configSyncError,
    update: updateConfig,
    channel: configChannel,
    retry: retryConfigSave,
    reload: reloadConfig,
  } = useUserConfig(automationConfigAdapter)

  // 协调器持有 task flow 与 schedule 的唯一草稿；页面只派生图标/参数表单等展示字段。
  const taskFlow = useMemo<TaskFlowItem[]>(() => (
    (configDraft?.taskFlow ?? []).map(item => {
      const commandId = item.commandId || item.id.split('-')[0]
      const originalTask = AVAILABLE_TASKS.find(task => task.id === item.commandId || task.id === commandId)
      return {
        ...item,
        icon: originalTask?.icon,
        paramFields: originalTask?.paramFields ?? [],
      }
    })
  ), [configDraft?.taskFlow])
  const scheduleEnabled = configDraft?.schedule.enabled ?? false
  const scheduleEntries = configDraft?.schedule.entries ?? createDefaultScheduleEntries()
  const isRetryingConfigSave = configSyncState === 'saving'

  const currentDraft = () => configChannel.getState().draft ?? createDefaultAutomationDraft()

  const handleRetryConfigSave = async () => {
    if (isRetryingConfigSave) return
    const saved = await retryConfigSave()
    if (saved) setStatusMessage('自动化配置已同步', 'success')
  }

  const [dragFlow, setDragFlow] = useState<TaskFlowItem[] | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [lastDeletedTask, setLastDeletedTask] = useState<DeletedTaskSnapshot | null>(null)
  const [sortAnnouncement, setSortAnnouncement] = useState('')
  const [currentActivity, setCurrentActivity] = useState<any>(null)
  const [activityName, setActivityName] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<Record<string, ConnectionTestStatus>>({})
  const [testingConnectionTaskId, setTestingConnectionTaskId] = useState<string | null>(null)
  const [lastExecutionSummary, setLastExecutionSummary] = useState<AutomationExecutionSummary | null>(null)
  const [executionDetailsOpen, setExecutionDetailsOpen] = useState(false)
  const connectionTestInFlightRef = useRef(false)
  const connectionTestAbortRef = useRef<AbortController | null>(null)
  const connectionTestMountedRef = useRef(true)
  const lastExecutionFingerprintRef = useRef('')
  const pointerSortRef = useRef<PointerSortSession | null>(null)
  const sequenceItemRefs = useRef(new Map<string, HTMLDivElement>())
  const editorColumnRef = useRef<HTMLDivElement>(null)
  const taskPickerRegionRef = useRef<HTMLDivElement>(null)
  // 拖拽期间只渲染本地预览，松手时才把最终顺序作为一次编辑写入协调器。
  const displayedTaskFlow = dragFlow ?? taskFlow
  const activeTaskId = selectedTaskId && displayedTaskFlow.some(task => task.id === selectedTaskId)
    ? selectedTaskId
    : displayedTaskFlow[0]?.id ?? null
  const displaySummary = executionSummary
    ?? (!isRunning && !isSubmitting ? executionScheduleSummary : null)
  const taskResults: TaskExecutionResult[] = isRunning
    ? executionProgress?.taskResults ?? []
    : isSubmitting
      ? []
      : displaySummary
        ? taskResultsFromSummary(displaySummary, displayedTaskFlow)
        : []
  const currentStep = isRunning && executionProgress
    ? resolveExecutionStep(displayedTaskFlow, executionProgress)
    : -1

  useEffect(() => {
    if (!displaySummary) return
    const fingerprint = JSON.stringify(displaySummary)
    if (lastExecutionFingerprintRef.current === fingerprint) return

    lastExecutionFingerprintRef.current = fingerprint
    setLastExecutionSummary(displaySummary)
    setExecutionDetailsOpen(executionSummaryHasFailure(displaySummary))
  }, [displaySummary])

  const taskExecutionState = (task: TaskFlowItem, index: number) => {
    if (!task.enabled) return 'idle'
    const result = taskResults.find(result => result.taskId === task.id)
    if (result) return result.status === 'running' && !isRunning ? 'stopped' : result.status
    if (!isRunning) return 'idle'
    return currentStep === index ? 'running' : currentStep > index ? 'success' : 'pending'
  }
  const executionLabel = (state: ReturnType<typeof taskExecutionState>) => ({
    idle: '', pending: isRunning ? '等待执行' : '未执行', running: '正在执行',
    success: '已完成', failed: '执行失败', skipped: '已跳过', stopped: '已终止',
  }[state])

  const selectTaskForEditing = (taskId: string) => {
    setSelectedTaskId(taskId)
    if (!window.matchMedia?.('(max-width: 899px)').matches) return

    window.requestAnimationFrame(() => {
      editorColumnRef.current?.scrollIntoView({
        behavior: shouldReduceMotion ? 'auto' : 'smooth',
        block: 'start',
      })
    })
  }

  useEffect(() => {
    connectionTestMountedRef.current = true
    setTestingConnectionTaskId(null)
    return () => {
      connectionTestMountedRef.current = false
      const connectionController = connectionTestAbortRef.current
      connectionController?.abort()
      if (connectionTestAbortRef.current === connectionController) {
        connectionTestAbortRef.current = null
        connectionTestInFlightRef.current = false
      }
    }
  }, [])

  const addTaskToFlow = (task: AutomationAvailableTask) => {
    const current = currentDraft()
    const added = appendTaskToFlow(current.taskFlow, task)

    updateConfig({ ...current, taskFlow: added.flow })
    setSelectedTaskId(added.task.id)
  }

  const removeTaskFromFlow = (index: number) => {
    const current = currentDraft()
    const removedTask = current.taskFlow[index]
    if (!removedTask) return
    const newFlow = removeTaskFlowItem(current.taskFlow, index)
    if (removedTask.id === activeTaskId) {
      setSelectedTaskId(newFlow[Math.min(index, newFlow.length - 1)]?.id ?? null)
    }
    const removedDisplayTask = taskFlow[index]
    if (removedDisplayTask) setLastDeletedTask({ task: removedDisplayTask, index })
    updateConfig({ ...current, taskFlow: newFlow })
  }

  const restoreDeletedTask = () => {
    if (!lastDeletedTask || isRunning) return
    const current = currentDraft()
    const newFlow = insertTaskFlowItem(
      current.taskFlow,
      toPersistedTaskFlowItem(lastDeletedTask.task),
      lastDeletedTask.index,
    )
    updateConfig({ ...current, taskFlow: newFlow })
    setSelectedTaskId(lastDeletedTask.task.id)
    setLastDeletedTask(null)
  }

  const toggleTaskEnabled = (index: number) => {
    const current = currentDraft()
    if (!current.taskFlow[index]) return
    updateConfig({ ...current, taskFlow: toggleTaskFlowItemEnabled(current.taskFlow, index) })
  }

  const restorePointerSort = () => {
    const session = pointerSortRef.current
    if (!session) return
    pointerSortRef.current = null
    setDraggedIndex(null)
    setDragFlow(null)
    if (session.changed) setSortAnnouncement('已取消排序')
  }

  const handleSortPointerDown = (event: React.PointerEvent<HTMLButtonElement>, taskId: string) => {
    if (isRunning || event.button !== 0 || pointerSortRef.current) return
    pointerSortRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      itemId: taskId,
      currentFlow: [...displayedTaskFlow],
      activated: false,
      changed: false
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Capture can fail if the pointer already ended.
    }
  }

  const handleSortPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = pointerSortRef.current
    if (!session || session.pointerId !== event.pointerId) return

    if (!session.activated) {
      if (!hasPointerSortActivated(session.startX, session.startY, event.clientX, event.clientY)) return
      session.activated = true
    }

    const currentFlow = session.currentFlow
    const currentIndex = currentFlow.findIndex(task => task.id === session.itemId)
    if (currentIndex < 0) return
    setDraggedIndex(currentIndex)

    const targetIndex = getPointerSortTargetIndex(currentFlow, session.itemId, event.clientY, taskId => {
      const rect = sequenceItemRefs.current.get(taskId)?.getBoundingClientRect()
      return rect ? rect.top + rect.height / 2 : null
    })
    if (targetIndex === currentIndex) return

    const newFlow = moveTaskFlowItem(currentFlow, currentIndex, targetIndex)
    session.currentFlow = newFlow
    session.changed = true
    setDragFlow(newFlow)
    setDraggedIndex(targetIndex)
  }

  const handleSortPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = pointerSortRef.current
    if (!session || session.pointerId !== event.pointerId) return
    pointerSortRef.current = null
    setDraggedIndex(null)
    setDragFlow(null)
    if (session.activated && session.changed) {
      const committedFlow = session.currentFlow
      const committedIndex = committedFlow.findIndex(task => task.id === session.itemId)
      const current = currentDraft()
      updateConfig({ ...current, taskFlow: toPersistedTaskFlow(committedFlow) })
      setSortAnnouncement(`${committedFlow[committedIndex]?.name || '任务'}已移动到第 ${committedIndex + 1} 位`)
    }
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The browser may have released capture before this handler runs.
    }
  }

  const handleSortPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = pointerSortRef.current
    if (!session || session.pointerId !== event.pointerId) return
    restorePointerSort()
  }

  const handleSortKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, taskId: string) => {
    if (isRunning || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const current = currentDraft()
    const currentIndex = current.taskFlow.findIndex(task => task.id === taskId)
    if (currentIndex < 0) return
    const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1
    const newFlow = moveTaskFlowItem(current.taskFlow, currentIndex, targetIndex)
    if (newFlow === current.taskFlow) return
    updateConfig({ ...current, taskFlow: newFlow })
    setSortAnnouncement(`${newFlow[targetIndex]?.name || '任务'}已移动到第 ${targetIndex + 1} 位`)
  }

  useEffect(() => {
    const cancelSortOnEscape = (event: KeyboardEvent) => {
      const session = pointerSortRef.current
      if (event.key !== 'Escape' || !session) return
      event.preventDefault()
      pointerSortRef.current = null
      setDraggedIndex(null)
      setDragFlow(null)
      if (session.changed) setSortAnnouncement('已取消排序')
    }
    window.addEventListener('keydown', cancelSortOnEscape)
    return () => window.removeEventListener('keydown', cancelSortOnEscape)
  }, [])

  const updateTaskParam = (index: number, key: string, value: any) => {
    const current = currentDraft()
    if (!current.taskFlow[index]) return

    updateConfig({
      ...current,
      taskFlow: updateTaskFlowParams(current.taskFlow, index, key, value),
    })
  }

  const testConnection = async (taskId: string) => {
    if (connectionTestInFlightRef.current) return

    const controller = new AbortController()
    const startedAt = Date.now()
    const waitForStableFeedback = async () => {
      const remaining = 450 - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    }
    connectionTestInFlightRef.current = true
    connectionTestAbortRef.current = controller
    setTestingConnectionTaskId(taskId)
    setConnectionStatus(prev => {
      const next = { ...prev }
      delete next[taskId]
      return next
    })

    try {
      const result = await testAdbConnection(undefined, undefined, controller.signal)
      await waitForStableFeedback()
      if (controller.signal.aborted) return
      const payload = result.data as ConnectionTestStatus | undefined
      const success = Boolean(result.success && payload?.success)
      setConnectionStatus(prev => ({
        ...prev,
        [taskId]: {
          success,
          message: payload?.message || getErrorMessage(result),
        },
      }))
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return
      await waitForStableFeedback()
      if (controller.signal.aborted) return
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setConnectionStatus(prev => ({
        ...prev,
        [taskId]: {
          success: false,
          message: errorMessage,
        }
      }))
    } finally {
      if (connectionTestAbortRef.current === controller) {
        connectionTestInFlightRef.current = false
        connectionTestAbortRef.current = null
        if (connectionTestMountedRef.current) setTestingConnectionTaskId(null)
      }
    }
  }

  // schedule 编辑与 task flow 写入同一条草稿通道：协调器负责本地草稿、完整提交与重试。
  const updateSchedule = (next: { enabled?: boolean; entries?: ScheduleTimeEntry[] }) => {
    const current = currentDraft()
    updateConfig({
      ...current,
      schedule: {
        enabled: next.enabled ?? current.schedule.enabled,
        entries: normalizeScheduleEntries(next.entries ?? current.schedule.entries),
      },
    })
  }

  const handleScheduleEnabledChange = (enabled: boolean) => {
    updateSchedule({ enabled })
  }

  const addScheduleTime = () => {
    const current = currentDraft()
    const nextEntries = appendScheduleEntry(current.schedule.entries)
    if (!nextEntries) {
      void showError('没有可添加的执行时间')
      return
    }

    updateSchedule({ entries: nextEntries })
  }

  const removeScheduleTime = (index: number) => {
    const current = currentDraft()
    updateSchedule({ entries: removeScheduleEntry(current.schedule.entries, index) })
  }

  const updateScheduleTimePart = (index: number, part: 'hour' | 'minute', rawValue: number) => {
    const current = currentDraft()
    const updated = updateScheduleTimeEntry(current.schedule.entries, index, part, rawValue)
    if (!updated.ok) {
      if (updated.reason === 'duplicate') void showError('该执行时间已经存在')
      return
    }

    updateSchedule({ entries: updated.entries })
  }

  const updateScheduleTimeEnabled = (index: number, enabled: boolean) => {
    const current = currentDraft()
    updateSchedule({ entries: setScheduleEntryEnabled(current.schedule.entries, index, enabled) })
  }

  const executeTaskFlow = async () => {
    if (!automationAvailable) {
      void showError(unavailableMessage)
      return
    }

    const invalidTask = findTaskFlowValidationFailure(displayedTaskFlow)
    if (invalidTask) {
      setSelectedTaskId(invalidTask.taskId)
      void showError(invalidTask.message)
      return
    }

    lastExecutionFingerprintRef.current = ''
    await submitFlow(displayedTaskFlow)
  }

  // 页面初始化只读取展示用活动信息；配置由 user-config 协调器在挂载时加载。
  useEffect(() => {
    let cancelled = false

    const initialize = async () => {
      try {
        const activityResult = await getActivity('Official')
        if (cancelled) return
        if (activityResult.success && activityResult.data?.code) {
          setCurrentActivity(activityResult.data.code)
          setActivityName(activityResult.data.name)
        }
      } catch {
        // 活动信息只用于展示，失败不影响任务流程。
      }
    }

    void initialize()
    return () => { cancelled = true }
  }, [])

  // 养成计划或队列同步成功后，经资源失效端口通知本页。应用计划前 training 已
  // 通过同一配置协调协议排空本页的在途保存；这里再等到通道空闲后强制重读，
  // 以免外部写入早于本页仍在途的旧保存。仍有 pending 失败草稿时保留本地并提示。
  const handleAutomationInvalidation = async (invalidation: ResourceInvalidation) => {
    const state = configChannel.getState()
    if (state.pending) await configChannel.flush()
    const outcome = await reloadConfig({ force: true })
    const detail = isRecord(invalidation.detail) ? invalidation.detail : null
    const stageCount = typeof detail?.stageCount === 'number' && Number.isFinite(detail.stageCount)
      ? detail.stageCount
      : null
    if (outcome.reason === 'loaded') {
      setStatusMessage(
        stageCount === null ? '智能养成计划已更新' : `智能养成计划已更新：${stageCount} 个关卡`,
        'success',
      )
    } else if (outcome.reason === 'local-draft' || outcome.reason === 'stale') {
      setStatusMessage('检测到本设备有未同步的流程编辑，已保留本地草稿；养成计划更新未覆盖本地配置', 'warning')
    } else if (outcome.reason === 'failed') {
      setStatusMessage('自动化配置刷新失败，请稍后重试', 'warning')
    }
  }

  // Effect 内订阅；Activity 隐藏时注销，恢复时由 hook 补发一次 activity-resume。
  useResourceInvalidation(AUTOMATION_RESOURCE_SCOPES, invalidation => {
    void handleAutomationInvalidation(invalidation)
  })

  // 监听页面可见性变化，切换回来时重试尚未成功的加载（已加载时协调器直接跳过）。
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (!document.hidden) {
        await reloadConfig()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [reloadConfig])

  const schedulePanel = (
    <div className="automation-schedule-column">
      <SmoothPanel className="automation-schedule-panel">
        <div className="automation-schedule-heading">
          <div>
            <h3><Clock3 size={16} strokeWidth={1.8} aria-hidden="true" /><span>定时与通知</span></h3>
            <p>自动运行与结果推送</p>
          </div>
          <div className="automation-schedule-actions">
            <Switch
              checked={scheduleEnabled}
              onChange={handleScheduleEnabledChange}
              disabled={isRunning}
              label="定时执行"
              className="automation-section-switch"
            />
          </div>
        </div>

        {scheduleEnabled ? (
          <motion.div
            className="automation-schedule-body"
            initial={shouldReduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
          >
            <div className="automation-schedule-list-heading">
              <span>执行时间</span>
              <div className="automation-schedule-list-heading-actions">
                <small aria-label={`已设置 ${scheduleEntries.length} 个执行时间`}>
                  {scheduleEntries.length} 个
                </small>
                {scheduleEntries.length < MAX_SCHEDULE_ENTRIES && (
                  <button
                    type="button"
                    onClick={addScheduleTime}
                    disabled={isRunning}
                    className="automation-schedule-add"
                  >
                    <span className="automation-schedule-add-plus" aria-hidden="true">+</span>
                    <span className="automation-schedule-add-text">新增定时</span>
                  </button>
                )}
              </div>
            </div>
            <div className="automation-schedule-times">
              {scheduleEntries.map((entry, index) => {
                const { hour, minute } = parseScheduleTime(entry.time)
                const hourId = `automation-schedule-hour-${index}`
                const minuteId = `automation-schedule-minute-${index}`
                const hourDisplay = String(hour)
                const minuteDisplay = String(minute).padStart(2, '0')

                return (
                  <div
                    key={`schedule-time-${index}`}
                    className={`automation-schedule-time-row${entry.enabled ? '' : ' is-disabled'}`}
                  >
                    {scheduleEntries.length > 1 ? (
                      <IconButton
                        icon={<CircleMinus size={22} strokeWidth={1.8} aria-hidden="true" />}
                        variant="ghost"
                        size="md"
                        onClick={() => removeScheduleTime(index)}
                        disabled={isRunning}
                        className="automation-schedule-remove min-h-11 min-w-11"
                        title="删除时间点"
                        aria-label={`删除第 ${index + 1} 个时间点`}
                      />
                    ) : <span className="automation-schedule-remove-placeholder" aria-hidden="true" />}

                    <div className="automation-schedule-time-fields" role="group" aria-label={`第 ${index + 1} 个执行时间`}>
                      <span className="automation-schedule-time-unit" aria-hidden="true">时</span>
                      <div className="automation-schedule-stepper">
                        <label htmlFor={hourId} className="sr-only">第 {index + 1} 个执行时间的小时</label>
                        <input
                          id={hourId}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={hourDisplay}
                          disabled={isRunning}
                          className="automation-schedule-stepper-input"
                          onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, '').slice(0, 2)
                            if (digits === '') return
                            updateScheduleTimePart(index, 'hour', Number(digits))
                          }}
                        />
                        <div className="automation-schedule-stepper-controls">
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={isRunning}
                            aria-label={`将第 ${index + 1} 个执行时间的小时增加 1`}
                            onClick={() => updateScheduleTimePart(index, 'hour', hour + 1)}
                          >
                            <ChevronUp size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={isRunning}
                            aria-label={`将第 ${index + 1} 个执行时间的小时减少 1`}
                            onClick={() => updateScheduleTimePart(index, 'hour', hour - 1)}
                          >
                            <ChevronDown size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <span className="automation-schedule-time-unit" aria-hidden="true">分</span>
                      <div className="automation-schedule-stepper">
                        <label htmlFor={minuteId} className="sr-only">第 {index + 1} 个执行时间的分钟</label>
                        <input
                          id={minuteId}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={minuteDisplay}
                          disabled={isRunning}
                          className="automation-schedule-stepper-input"
                          onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, '').slice(0, 2)
                            if (digits === '') return
                            updateScheduleTimePart(index, 'minute', Number(digits))
                          }}
                        />
                        <div className="automation-schedule-stepper-controls">
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={isRunning}
                            aria-label={`将第 ${index + 1} 个执行时间的分钟增加 1`}
                            onClick={() => updateScheduleTimePart(index, 'minute', minute + 1)}
                          >
                            <ChevronUp size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={isRunning}
                            aria-label={`将第 ${index + 1} 个执行时间的分钟减少 1`}
                            onClick={() => updateScheduleTimePart(index, 'minute', minute - 1)}
                          >
                            <ChevronDown size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="automation-schedule-time-enable">
                      <span className="automation-schedule-time-enable-label" aria-hidden="true">开启</span>
                      <Switch
                        checked={entry.enabled}
                        onChange={(enabled) => updateScheduleTimeEnabled(index, enabled)}
                        disabled={isRunning}
                        label={`第 ${index + 1} 个执行时间开启`}
                        compact
                        className="automation-schedule-time-switch"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        ) : (
          <div className="automation-schedule-empty">
            <strong>定时运行已关闭</strong>
            <p>打开右上角开关后设置执行时间</p>
          </div>
        )}

        <NotificationSettings />
      </SmoothPanel>
    </div>
  )

  return (
    <>
      <div className="app-page ios-workspace-page" data-automation-tasks>
        <div className="app-stack-section">
        {/* 页面标题 */}
        <PageHeader
          title="日常任务"
          subtitle="安排日常流程，一键执行或定时运行"
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

        <div className="automation-workspace-grid">
          {/* 紧凑流程顺序 */}
          <div className="automation-sequence-column">
            <SmoothPanel
              className="automation-sequence-panel"
              surfaceClassName="automation-sequence-surface"
            >
              <div className="automation-flow-header">
                <div className="min-w-0">
                  <h3>
                    <ClipboardList size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span>任务流程</span>
                  </h3>
                  <p className="automation-flow-meta">
                    <span>按顺序执行，可拖拽调整</span>
                    {currentActivity && (
                      <span className="automation-flow-activity">
                        当前活动 · {activityName || currentActivity}
                      </span>
                    )}
                  </p>
                </div>
                <span className="automation-flow-summary">
                  {displayedTaskFlow.filter(t => t.enabled).length}/{displayedTaskFlow.length}
                </span>
                <span className="sr-only" aria-live="polite">{sortAnnouncement}</span>
              </div>

              {displayedTaskFlow.length === 0 ? (
                <EmptyState
                  className="automation-sequence-empty"
                  compact
                  icon={<ListPlus size={20} strokeWidth={1.8} />}
                  title="流程为空"
                  description="使用下方入口添加任务"
                />
              ) : (
                <div className="automation-sequence-list">
                  {displayedTaskFlow.map((task, index) => {
                    const executionState = taskExecutionState(task, index)
                    const isCurrentStep = executionState === 'running'
                    const isCompletedStep = executionState === 'success'
                    const isSelectedTask = activeTaskId === task.id

                    return (
                      <motion.div
                        key={task.id}
                        layout={!shouldReduceMotion}
                        ref={(node) => {
                          if (node) sequenceItemRefs.current.set(task.id, node)
                          else sequenceItemRefs.current.delete(task.id)
                        }}
                        className={`automation-sequence-item${isSelectedTask ? ' is-selected' : ''}${isCurrentStep ? ' is-current' : ''}${isCompletedStep ? ' is-completed' : ''}${executionState === 'failed' ? ' is-failed' : ''}${executionState === 'skipped' || executionState === 'stopped' ? ' is-skipped' : ''}${!task.enabled ? ' is-disabled' : ''}${draggedIndex === index ? ' is-dragging' : ''}`}
                        data-selected={isSelectedTask ? 'true' : 'false'}
                        data-execution-state={isCompletedStep ? 'completed' : executionState === 'pending' && isRunning ? 'idle' : executionState}
                      >
                      <button
                        type="button"
                        onPointerDown={(event) => handleSortPointerDown(event, task.id)}
                        onPointerMove={handleSortPointerMove}
                        onPointerUp={handleSortPointerUp}
                        onPointerCancel={handleSortPointerCancel}
                        onLostPointerCapture={handleSortPointerCancel}
                        onKeyDown={(event) => handleSortKeyDown(event, task.id)}
                        className={`automation-sequence-drag min-h-11 min-w-11 touch-none${isRunning ? ' is-placeholder' : ''}`}
                        title={isRunning ? '执行期间不能排序' : '拖动排序，或使用上下方向键调整'}
                        aria-label={`调整${task.name}顺序，当前第 ${index + 1} 位`}
                        disabled={isRunning}
                      >
                        <GripVertical size={16} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="automation-sequence-select"
                        onClick={() => selectTaskForEditing(task.id)}
                        aria-controls="automation-task-editor"
                        aria-pressed={isSelectedTask}
                        aria-current={isCurrentStep ? 'step' : undefined}
                      >
                        <span className="automation-sequence-node" aria-hidden="true">
                          <span>
                              {isCompletedStep
                                ? <Check size={11} strokeWidth={2.8} />
                                : isCurrentStep
                                  ? <LoaderCircle className="automation-sequence-progress" size={13} strokeWidth={2.3} />
                                : executionState === 'failed'
                                  ? <AlertTriangle size={12} strokeWidth={2} />
                                : executionState === 'skipped' || executionState === 'stopped'
                                  ? <Minus size={12} strokeWidth={2} />
                                : String(index + 1).padStart(2, '0')}
                          </span>
                        </span>
                        <span className="automation-sequence-copy">
                          <strong>{task.name}</strong>
                          <small>{executionLabel(executionState) || task.description}</small>
                        </span>
                      </button>
                      <span className="automation-sequence-enabled">
                        <Switch
                          compact
                          checked={task.enabled}
                          onChange={() => toggleTaskEnabled(index)}
                          disabled={isRunning}
                          label={`${task.name}启用状态`}
                        />
                      </span>
                      {isRunning && isCompletedStep ? (
                        <span className="automation-completed-mark" role="img" aria-label="已完成" title="已完成">
                          <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                        </span>
                      ) : !isCurrentStep ? (
                        <button
                          type="button"
                          onClick={() => removeTaskFromFlow(index)}
                          disabled={isRunning}
                          className="automation-sequence-delete min-h-11 min-w-11"
                          title="删除任务"
                          aria-label={`删除${task.name}`}
                        >
                          <Trash2 size={14} strokeWidth={1.9} />
                        </button>
                      ) : null}
                      </motion.div>
                    )
                  })}
                </div>
              )}

              {lastDeletedTask && (
                <div className="mx-3.5 flex min-h-11 items-center justify-between gap-3 border-t border-(--app-border) text-xs text-secondary sm:mx-4" role="status">
                  <span className="min-w-0 truncate">已删除“{lastDeletedTask.task.name}”</span>
                  <button
                    type="button"
                    onClick={restoreDeletedTask}
                    disabled={isRunning}
                    className="min-h-11 shrink-0 px-2 font-medium text-(--app-accent) disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    恢复
                  </button>
                </div>
              )}

              <div ref={taskPickerRegionRef} className="automation-sequence-footer">
                  <AutomationTaskPicker
                    flow={displayedTaskFlow}
                    disabled={isRunning}
                    onAddTask={addTaskToFlow}
                    regionRef={taskPickerRegionRef}
                  />
                  <Button
                    onClick={executeTaskFlow}
                    disabled={!automationAvailable || isRunning || isSubmitting || displayedTaskFlow.filter(t => t.enabled).length === 0}
                    title={!automationAvailable ? unavailableMessage : undefined}
                    loading={isRunning || isSubmitting}
                    loadingText={isRunning ? '执行中' : '正在启动'}
                    statusKey={isRunning || isSubmitting ? 'running' : 'ready'}
                    variant="primary"
                    className={`automation-run-button w-full justify-center whitespace-nowrap${isRunning ? ' is-running' : ''}`}
                    icon={<Play size={16} fill="currentColor" aria-hidden="true" />}
                  >
                    立即执行
                  </Button>
                  {isRunning && (
                    <Button
                      onClick={stopTaskFlow}
                      disabled={isStopping}
                      loading={isStopping}
                      loadingText="正在终止"
                      statusKey={isStopping ? 'stopping' : 'stop-ready'}
                      variant={isStopping ? 'secondary' : 'danger'}
                      className={`automation-stop-button w-full justify-center${isStopping ? ' is-stopping' : ''}`}
                      icon={<Square size={14} fill="currentColor" />}
                    >
                      终止执行
                    </Button>
                  )}
              </div>

              {lastExecutionSummary && (
                <section className="border-t border-(--app-border) px-3.5 py-3 sm:px-4" aria-label="最近执行结果">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">最近执行</h4>
                    <span className="text-[11px] text-gray-400 dark:text-gray-500">
                      成功 {lastExecutionSummary.successCount}
                      {lastExecutionSummary.failedCount > 0 && ` · 失败 ${lastExecutionSummary.failedCount}`}
                      {lastExecutionSummary.skippedCount > 0 && ` · 跳过 ${lastExecutionSummary.skippedCount}`}
                      {` · ${Math.max(1, Math.round(lastExecutionSummary.durationMs / 1000))} 秒`}
                    </span>
                  </div>

                  <div className="mt-2 flex min-w-0 items-center gap-2">
                    {executionSummaryHasFailure(lastExecutionSummary)
                      ? <AlertTriangle size={14} className="shrink-0 text-red-500" strokeWidth={2} />
                      : lastExecutionSummary.skippedCount > 0 && lastExecutionSummary.successCount === 0
                        ? <CircleMinus size={14} className="shrink-0 text-gray-400" strokeWidth={2} />
                        : <CheckCircle2 size={14} className="shrink-0 text-emerald-500" strokeWidth={2} />}
                    <span className="min-w-0 flex-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
                      {formatExecutionActionSummary(lastExecutionSummary.actions)
                        || (lastExecutionSummary.failedCount > 0
                          ? `${lastExecutionSummary.failedCount} 项任务执行失败`
                          : lastExecutionSummary.skippedCount > 0
                            ? `${lastExecutionSummary.skippedCount} 项任务已跳过`
                            : '任务流程执行完成')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setExecutionDetailsOpen(open => !open)}
                      aria-expanded={executionDetailsOpen}
                      aria-label={executionDetailsOpen ? '收起执行详情' : '展开执行详情'}
                      title={executionDetailsOpen ? '收起详情' : '展开详情'}
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 dark:hover:bg-white/5 dark:hover:text-gray-200"
                    >
                      <ChevronDown
                        size={15}
                        strokeWidth={2}
                        className={`${shouldReduceMotion ? '' : 'transition-transform duration-200'} ${executionDetailsOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </div>

                  {executionDetailsOpen && (
                    <motion.div
                      initial={shouldReduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
                      className="overflow-hidden"
                    >
                      {lastExecutionSummary.summaries.some(summary => summary.stage || summary.drops) && (
                        <div className="mt-2 space-y-2 border-t border-(--app-border) pt-2">
                          {lastExecutionSummary.summaries
                            .filter(summary => summary.stage || summary.drops)
                            .map((summary, summaryIndex) => (
                              <div key={`${summary.task}-${summary.stage || summaryIndex}`} className="min-w-0 text-xs">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-gray-700 dark:text-gray-200">
                                  <span className="font-semibold">{summary.stage || summary.task}</span>
                                  {summary.times && <span className="text-gray-400">{summary.times} 次</span>}
                                  {summary.duration && <span className="text-gray-400">{summary.duration}</span>}
                                </div>
                                {summary.drops && (
                                  <p className="mt-1 wrap-break-word leading-5 text-gray-500 dark:text-gray-400">{summary.drops}</p>
                                )}
                              </div>
                            ))}
                        </div>
                      )}

                      {lastExecutionSummary.reports.length > 0 && (
                        <div className="mt-2 space-y-1.5 border-t border-(--app-border) pt-2">
                          {lastExecutionSummary.reports.map((report, reportIndex) => (
                            <div
                              key={`${report.provider}-${report.stage || reportIndex}-${reportIndex}`}
                              className={`flex min-w-0 items-start gap-2 text-xs ${report.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
                            >
                              {report.status === 'success'
                                ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
                                : <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={2} />}
                              <span className="min-w-0 wrap-break-word">
                                {report.message}{report.stage ? ` · ${report.stage}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {lastExecutionSummary.actions?.length > 0 && (
                        <div className="mt-2 space-y-1.5 border-t border-(--app-border) pt-2">
                          {lastExecutionSummary.actions.map((action, actionIndex) => (
                            <div
                              key={`${action.action}-${action.task}-${actionIndex}`}
                              className={`flex min-w-0 items-start gap-2 text-xs ${action.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : action.status === 'skipped' ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'}`}
                            >
                              {action.status === 'success'
                                ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
                                : action.status === 'skipped'
                                  ? <CircleMinus size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
                                  : <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={2} />}
                              <span className="min-w-0 wrap-break-word">{action.message}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {lastExecutionSummary.errors
                        ?.filter(error => {
                          const taskName = typeof error === 'string' ? error : error.task
                          return !lastExecutionSummary.actions?.some(action => action.status === 'failed' && action.task === taskName)
                        })
                        .map((error, errorIndex) => (
                          <p key={`${typeof error === 'string' ? error : error.task}-${errorIndex}`} className="mt-2 flex items-start gap-2 text-xs leading-5 text-red-600 dark:text-red-400">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
                            <span>{typeof error === 'string' ? error : `${error.task}：${error.error}`}</span>
                          </p>
                        ))}

                      {lastExecutionSummary.warnings.map((warning, warningIndex) => (
                        <p key={`${warning}-${warningIndex}`} className="mt-2 flex items-start gap-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
                          <span>{warning}</span>
                        </p>
                      ))}
                    </motion.div>
                  )}
                </section>
              )}
            </SmoothPanel>
          </div>

          {/* 当前任务配置 */}
          <div ref={editorColumnRef} id="automation-task-editor" className="automation-editor-column" tabIndex={-1}>
            <SmoothPanel className="automation-editor-panel">
              <div className="automation-editor-heading">
                <div>
                  <h3><SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" /><span>任务配置</span></h3>
                  <p>选择流程步骤后调整参数</p>
                </div>
                {activeTaskId && (
                  <span>{String(displayedTaskFlow.findIndex(task => task.id === activeTaskId) + 1).padStart(2, '0')}</span>
                )}
              </div>
              {!activeTaskId ? (
                <EmptyState
                  className="automation-editor-empty"
                  compact
                  icon={<SlidersHorizontal size={22} strokeWidth={1.7} />}
                  title="暂无可配置任务"
                  description="先从任务流程中添加一个任务"
                />
              ) : (
                <div className="automation-editor-content">
                  {displayedTaskFlow.filter(task => task.id === activeTaskId).map((task) => {
                    const index = displayedTaskFlow.findIndex(item => item.id === task.id)
                    const isCurrentTask = taskExecutionState(task, index) === 'running'
                    const connectionFeedback = connectionStatus[task.id]
                    const isTestingConnection = testingConnectionTaskId === task.id
                    const parameterFields = task.paramFields ?? []
                    const usesGroupedParameterRows = parameterFields.length > 0 && parameterFields.every(field => (
                      field.type === 'select' || field.type === 'text' || field.type === 'number'
                    ))

                    return (
                    <div
                      key={task.id}
                      className={`automation-task-editor${isCurrentTask ? ' is-current' : ''}${!task.enabled ? ' is-disabled' : ''}`}
                    >
                      <div className="automation-flow-card-header">
                        <div className="automation-flow-card-identity">
                          <span className="automation-flow-sequence">{String(index + 1).padStart(2, '0')}</span>
                          <span className="automation-flow-task-icon">{task.icon}</span>
                          <span className="automation-flow-task-name">
                            <strong>{task.name}</strong>
                            <small>{isCurrentTask ? '正在执行' : task.taskType || task.commandId}</small>
                          </span>
                        </div>
                        <div className="automation-flow-card-controls">
                          <Switch
                            checked={task.enabled}
                            onChange={() => toggleTaskEnabled(index)}
                            disabled={isRunning}
                            label={`${task.name}启用状态`}
                          />
                          {!isCurrentTask && (
                            <button
                              type="button"
                              onClick={() => removeTaskFromFlow(index)}
                              disabled={isRunning}
                              className="automation-delete-task min-h-11 min-w-11"
                              title="删除任务"
                              aria-label={`删除${task.name}`}
                            >
                              <Trash2 size={16} strokeWidth={1.9} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 参数配置区域 */}
                      {task.paramFields && task.paramFields.length > 0 && (
                        <div className={`automation-param-fields${usesGroupedParameterRows ? ' is-grouped' : ''}`}>
                          {task.paramFields.map((field) => {
                            if (field.visibleWhen && String(task.params[field.visibleWhen.key] ?? '') !== String(field.visibleWhen.value)) {
                              return null
                            }
                            if (field.hiddenWhen && String(task.params[field.hiddenWhen.key] ?? '') === String(field.hiddenWhen.value)) {
                              return null
                            }
                            const fieldId = `automation-${task.id}-${field.key}`
                            return (
                            <div key={field.key} className={`automation-param-field is-${field.type}`}>
                              {field.type === 'checkbox' ? (
                                <label htmlFor={fieldId} className="group flex min-h-11 cursor-pointer items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    id={fieldId}
                                    type="checkbox"
                                    checked={task.params[field.key] || false}
                                    onChange={(e) => updateTaskParam(index, field.key, e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  <span className="group-hover:text-(--app-accent) transition-colors">{field.label}</span>
                                </label>
                              ) : field.type === 'multi-stages' ? (
                                <AutomationStageEditor
                                  field={field}
                                  fieldId={fieldId}
                                  task={task}
                                  taskIndex={index}
                                  isRunning={isRunning}
                                  onUpdate={updateTaskParam}
                                  onSuccess={showSuccess}
                                  onError={showError}
                                />
                              ) : field.type === 'stage-with-times' ? (
                                <div className="flex items-center space-x-2">
                                  <label htmlFor={fieldId} className="automation-field-label w-20 whitespace-nowrap">{field.label}</label>
                                  <div className="automation-composite-control flex items-center flex-1 max-w-70">
                                    <input
                                      id={fieldId}
                                      type="text"
                                      value={task.params[field.key] || ''}
                                      onChange={(e) => updateTaskParam(index, field.key, e.target.value)}
                                      placeholder={field.placeholder}
                                      disabled={isRunning || !task.enabled}
                                      className="flex-1 px-3 py-2 bg-transparent text-sm text-gray-900 dark:text-gray-200 focus:outline-hidden min-w-0"
                                    />
                                    <div className="w-px h-6 bg-white/20"></div>
                                    <input
                                      id={`${fieldId}-times`}
                                      type="number"
                                      aria-label={`${field.label}执行次数`}
                                      value={task.params.times || ''}
                                      onChange={(e) => updateTaskParam(index, 'times', e.target.value)}
                                      placeholder=""
                                      disabled={isRunning || !task.enabled}
                                      className="w-16 px-2 py-2 bg-transparent text-sm text-gray-900 dark:text-gray-200 text-center focus:outline-hidden [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                      min="0"
                                    />
                                    <div className="hidden flex-col self-stretch overflow-hidden border-l border-white/10 min-[900px]:flex">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const currentValue = Number(task.params.times) || 0;
                                          updateTaskParam(index, 'times', (currentValue + 1).toString());
                                        }}
                                        disabled={isRunning || !task.enabled}
                                        className="flex-1 px-1.5 bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center rounded-tr-xl"
                                        aria-label={`增加${field.label}执行次数`}
                                      >
                                        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                                        </svg>
                                      </button>
                                      <div className="w-full h-px bg-white/10"></div>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const currentValue = Number(task.params.times) || 0;
                                          if (currentValue > 0) {
                                            updateTaskParam(index, 'times', (currentValue - 1).toString());
                                          }
                                        }}
                                        disabled={isRunning || !task.enabled}
                                        className="flex-1 px-1.5 bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center rounded-br-xl"
                                        aria-label={`减少${field.label}执行次数`}
                                      >
                                        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ) : field.type === 'star-select' ? (
                                <fieldset>
                                  <legend className="automation-field-label mb-2 block">{field.label}</legend>
                                  <div className="flex items-center space-x-2 flex-wrap">
                                    {[3, 4, 5, 6].map(star => {
                                      const currentValue = Array.isArray(task.params[field.key]) ? task.params[field.key] : [];
                                      const isChecked = currentValue.includes(star);
                                      const optionId = `${fieldId}-${star}`
                                      return (
                                        <label key={star} htmlFor={optionId} className="group flex min-h-11 cursor-pointer items-center space-x-1 text-sm text-gray-700 dark:text-gray-300">
                                          <input
                                            id={optionId}
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={(e) => {
                                              const newValue = e.target.checked
                                                ? [...currentValue, star].sort()
                                                : currentValue.filter((s: number) => s !== star);
                                              updateTaskParam(index, field.key, newValue);
                                            }}
                                            disabled={isRunning || !task.enabled}
                                            className="custom-checkbox cursor-pointer"
                                          />
                                          <span className="group-hover:text-(--app-accent) transition-colors flex items-center space-x-1">
                                            <span>{star}</span>
                                            <svg className="w-3.5 h-3.5 brand-text" fill="currentColor" viewBox="0 0 20 20">
                                              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                            </svg>
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                  {task.id === 'recruit' && field.key === 'select' && Array.isArray(task.params.select) && task.params.select.includes(6) && (
                                    <div className="mt-2 rounded-xl px-3 py-2 text-xs brand-chip">
                                      已开启 6 星自动公招：遇到高级资深干员等高价值标签时，会优先保留并自动选择。
                                    </div>
                                  )}
                                </fieldset>
                              ) : field.type === 'facility-select' ? (
                                <fieldset>
                                  <legend className="automation-field-label mb-2 block">{field.label}</legend>
                                  <div className="grid grid-cols-2 gap-2">
                                    {[
                                      { value: 'Mfg', label: '制造站' },
                                      { value: 'Trade', label: '贸易站' },
                                      { value: 'Power', label: '发电站' },
                                      { value: 'Control', label: '控制中枢' },
                                      { value: 'Reception', label: '会客室' },
                                      { value: 'Office', label: '办公室' },
                                      { value: 'Dorm', label: '宿舍' },
                                      { value: 'Processing', label: '加工站' },
                                      { value: 'Training', label: '训练室' }
                                    ].map(facility => {
                                      const currentValue = Array.isArray(task.params[field.key]) ? task.params[field.key] : [];
                                      const isChecked = currentValue.includes(facility.value);
                                      const optionId = `${fieldId}-${facility.value}`
                                      return (
                                        <label key={facility.value} htmlFor={optionId} className="group flex min-h-11 cursor-pointer items-center space-x-1 text-sm text-gray-700 dark:text-gray-300">
                                          <input
                                            id={optionId}
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={(e) => {
                                              const newValue = e.target.checked
                                                ? [...currentValue, facility.value]
                                                : currentValue.filter((f: string) => f !== facility.value);
                                              updateTaskParam(index, field.key, newValue);
                                            }}
                                            disabled={isRunning || !task.enabled}
                                            className="custom-checkbox cursor-pointer"
                                          />
                                          <span className="group-hover:text-(--app-accent) transition-colors">{facility.label}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </fieldset>
                              ) : field.type === 'select' ? (
                                <div className="automation-field-row">
                                  <label htmlFor={fieldId} className="automation-field-label">{field.label}</label>
                                  <div className="automation-select-control">
                                    <select
                                      id={fieldId}
                                      value={task.params[field.key] || (Array.isArray(field.options) && field.options.length > 0 ? (typeof field.options[0] === 'object' ? field.options[0].value : field.options[0]) : '')}
                                      onChange={(e) => updateTaskParam(index, field.key, e.target.value)}
                                      disabled={isRunning || !task.enabled}
                                    >
                                      {Array.isArray(field.options) && field.options.map((opt) => {
                                        const value = typeof opt === 'object' ? opt.value : opt
                                        const label = typeof opt === 'object' ? opt.label : opt
                                        return <option key={String(value)} value={String(value)}>{label}</option>
                                      })}
                                    </select>
                                    <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
                                  </div>
                                </div>
                              ) : (
                                <div className="automation-field-row">
                                  <label htmlFor={fieldId} className="automation-field-label">{field.label}</label>
                                  {field.type === 'number' ? (
                                    <div className="number-input-wrapper flex-1">
                                      <input
                                        id={fieldId}
                                        type="number"
                                        value={task.params[field.key] || ''}
                                        onChange={(e) => updateTaskParam(index, field.key, e.target.value)}
                                        placeholder={field.placeholder}
                                        step={field.step}
                                        min={field.min}
                                        max={field.max}
                                        disabled={isRunning || !task.enabled}
                                        className="automation-number-control"
                                      />
                                      <div className="number-input-controls hidden min-[900px]:flex">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const currentValue = Number(task.params[field.key]) || 0;
                                            const step = Number(field.step) || 1;
                                            const min = field.min !== undefined ? Number(field.min) : -Infinity;
                                            const newValue = Math.max(currentValue - step, min);
                                            updateTaskParam(index, field.key, newValue.toString());
                                          }}
                                          disabled={isRunning || !task.enabled}
                                          aria-label={`减少${field.label}`}
                                        >
                                          <Minus size={14} strokeWidth={2.2} aria-hidden="true" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const currentValue = Number(task.params[field.key]) || 0;
                                            const step = Number(field.step) || 1;
                                            const max = field.max !== undefined ? Number(field.max) : Infinity;
                                            const newValue = Math.min(currentValue + step, max);
                                            updateTaskParam(index, field.key, newValue.toString());
                                          }}
                                          disabled={isRunning || !task.enabled}
                                          aria-label={`增加${field.label}`}
                                        >
                                          <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <input
                                      id={fieldId}
                                      type={field.type}
                                      value={task.params[field.key] || ''}
                                      onChange={(e) => updateTaskParam(index, field.key, e.target.value)}
                                      placeholder={field.placeholder}
                                      step={field.step}
                                      min={field.min}
                                      max={field.max}
                                      disabled={isRunning || !task.enabled}
                                      className="automation-text-control"
                                    />
                                  )}
                                </div>
                              )}
                              {field.helper && (
                                <p className="automation-field-helper">
                                  <Info size={13} strokeWidth={1.8} aria-hidden="true" />
                                  <span>{field.helper}</span>
                                </p>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      )}

                      {task.commandId === 'fight' && (
                        <details className="group mt-3 rounded-lg border border-(--app-border) bg-(--app-surface-muted) px-3 py-2">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-700 marker:hidden dark:text-gray-200 [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center gap-2">
                              <SlidersHorizontal size={15} strokeWidth={1.9} />
                              高级设置
                            </span>
                            <ChevronDown size={15} strokeWidth={2} className="transition-transform group-open:rotate-180" />
                          </summary>

                          <div className="mt-3 space-y-3 border-t border-(--app-border) pt-3">
                            <div className="flex items-center gap-2">
                              <label htmlFor={`${task.id}-fight-client-type`} className="w-24 shrink-0 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">闪退重启:</label>
                              <div className="automation-select-control min-w-0 flex-1">
                                <select
                                  id={`${task.id}-fight-client-type`}
                                  value={task.params.clientType || ''}
                                  onChange={(e) => updateTaskParam(index, 'clientType', e.target.value)}
                                  disabled={isRunning || !task.enabled}
                                >
                                  <option value="">不启用</option>
                                  <option value="Official">官服</option>
                                  <option value="Bilibili">B服</option>
                                  <option value="YoStarEN">美服</option>
                                  <option value="YoStarJP">日服</option>
                                  <option value="YoStarKR">韩服</option>
                                  <option value="Txwy">繁中服</option>
                                </select>
                                <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
                              </div>
                            </div>
                            <p className="text-xs text-gray-400 dark:text-gray-500">选择客户端后，游戏闪退时会自动重新启动。</p>

                            <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                              <input
                                type="checkbox"
                                checked={Boolean(task.params.DrGrandet)}
                                onChange={(e) => updateTaskParam(index, 'DrGrandet', e.target.checked)}
                                disabled={isRunning || !task.enabled}
                                className="custom-checkbox mt-0.5 cursor-pointer"
                              />
                              <span>
                                <span className="block">葛朗台碎石模式</span>
                                <span className="mt-0.5 block text-xs text-gray-400 dark:text-gray-500">使用源石前等待自然恢复 1 点理智，尽量减少碎石浪费。</span>
                              </span>
                            </label>

                            <section className="space-y-2 border-t border-(--app-border) pt-3">
                              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                <input
                                  type="checkbox"
                                  checked={Boolean(task.params.report_to_penguin)}
                                  onChange={(e) => updateTaskParam(index, 'report_to_penguin', e.target.checked)}
                                  disabled={isRunning || !task.enabled}
                                  className="custom-checkbox cursor-pointer"
                                />
                                汇报掉落至企鹅物流
                              </label>
                              {task.params.report_to_penguin && (
                                <div className="flex items-center gap-2 pl-6">
                                  <label htmlFor={`${task.id}-penguin-id`} className="w-20 shrink-0 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">用户 ID:</label>
                                  <input
                                    id={`${task.id}-penguin-id`}
                                    type="text"
                                    value={task.params.penguin_id || ''}
                                    onChange={(e) => updateTaskParam(index, 'penguin_id', e.target.value)}
                                    placeholder="留空则匿名汇报"
                                    disabled={isRunning || !task.enabled}
                                    className="automation-text-control min-w-0 flex-1"
                                  />
                                </div>
                              )}
                            </section>

                            <section className="space-y-2 border-t border-(--app-border) pt-3">
                              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                <input
                                  type="checkbox"
                                  checked={Boolean(task.params.report_to_yituliu)}
                                  onChange={(e) => updateTaskParam(index, 'report_to_yituliu', e.target.checked)}
                                  disabled={isRunning || !task.enabled}
                                  className="custom-checkbox cursor-pointer"
                                />
                                汇报掉落至一图流
                              </label>
                              {task.params.report_to_yituliu && (
                                <div className="flex items-center gap-2 pl-6">
                                  <label htmlFor={`${task.id}-yituliu-id`} className="w-20 shrink-0 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">用户 ID:</label>
                                  <input
                                    id={`${task.id}-yituliu-id`}
                                    type="text"
                                    value={task.params.yituliu_id || ''}
                                    onChange={(e) => updateTaskParam(index, 'yituliu_id', e.target.value)}
                                    placeholder="留空则匿名汇报"
                                    disabled={isRunning || !task.enabled}
                                    className="automation-text-control min-w-0 flex-1"
                                  />
                                </div>
                              )}
                            </section>
                          </div>
                        </details>
                      )}

                      {task.commandId === 'infrast' && (
                        <details className="group mt-3 rounded-lg border border-(--app-border) bg-(--app-surface-muted) px-3 py-2">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-700 marker:hidden dark:text-gray-200 [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center gap-2">
                              <SlidersHorizontal size={15} strokeWidth={1.9} />
                              高级设置
                            </span>
                            <ChevronDown size={15} strokeWidth={2} className="transition-transform group-open:rotate-180" />
                          </summary>

                          <div className="mt-3 space-y-3 border-t border-(--app-border) pt-3">
                            {Array.isArray(task.params.facility) && task.params.facility.includes('Dorm') && (
                              <section className="space-y-2">
                                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400">宿舍</h4>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.dorm_notstationed_enabled)}
                                    onChange={(e) => updateTaskParam(index, 'dorm_notstationed_enabled', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  使用“未进驻”筛选
                                </label>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.dorm_trust_enabled)}
                                    onChange={(e) => updateTaskParam(index, 'dorm_trust_enabled', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  空位补入未满信赖干员
                                </label>
                              </section>
                            )}

                            {Array.isArray(task.params.facility) && task.params.facility.includes('Reception') && (
                              <section className="space-y-2 border-t border-(--app-border) pt-3">
                                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400">会客室</h4>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.reception_message_board)}
                                    onChange={(e) => updateTaskParam(index, 'reception_message_board', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  领取信息板信用
                                </label>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.reception_clue_exchange)}
                                    onChange={(e) => updateTaskParam(index, 'reception_clue_exchange', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  发起线索交流
                                </label>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.reception_send_clue)}
                                    onChange={(e) => updateTaskParam(index, 'reception_send_clue', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  自动赠送线索
                                </label>
                              </section>
                            )}

                            {Array.isArray(task.params.facility) && task.params.facility.includes('Training') && (
                              <section className="space-y-2 border-t border-(--app-border) pt-3">
                                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400">训练室</h4>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(task.params.continue_training)}
                                    onChange={(e) => updateTaskParam(index, 'continue_training', e.target.checked)}
                                    disabled={isRunning || !task.enabled}
                                    className="custom-checkbox cursor-pointer"
                                  />
                                  完成后继续专精
                                </label>
                              </section>
                            )}
                          </div>
                        </details>
                      )}

                      {task.commandId === 'recruit' && (
                        <details className="group mt-3 rounded-lg border border-(--app-border) bg-(--app-surface-muted) px-3 py-2">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-700 marker:hidden dark:text-gray-200 [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center gap-2">
                              <SlidersHorizontal size={15} strokeWidth={1.9} />
                              高级设置
                            </span>
                            <ChevronDown size={15} strokeWidth={2} className="transition-transform group-open:rotate-180" />
                          </summary>

                          <div className="mt-3 space-y-3 border-t border-(--app-border) pt-3">
                            <div className="flex items-center gap-2">
                              <label htmlFor={`${task.id}-extra-tags-mode`} className="w-20 shrink-0 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">额外标签:</label>
                              <div className="automation-select-control min-w-0 flex-1">
                                <select
                                  id={`${task.id}-extra-tags-mode`}
                                  value={String(task.params.extra_tags_mode ?? 0)}
                                  onChange={(e) => updateTaskParam(index, 'extra_tags_mode', Number(e.target.value))}
                                  disabled={isRunning || !task.enabled}
                                >
                                  <option value="0">标准选择</option>
                                  <option value="1">选满 3 个标签</option>
                                  <option value="2">尽量多选高星标签</option>
                                </select>
                                <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <label htmlFor={`${task.id}-first-tags`} className="w-20 shrink-0 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">三星首选:</label>
                              <input
                                id={`${task.id}-first-tags`}
                                type="text"
                                value={Array.isArray(task.params.first_tags) ? task.params.first_tags.join(',') : (task.params.first_tags || '')}
                                onChange={(e) => updateTaskParam(index, 'first_tags', e.target.value)}
                                placeholder="近卫干员,治疗"
                                disabled={isRunning || !task.enabled}
                                className="automation-text-control min-w-0 flex-1"
                              />
                            </div>
                            <p className="text-xs text-gray-400 dark:text-gray-500">仅在三星组合中优先选择，多个标签用逗号分隔。</p>

                            <fieldset>
                              <legend className="mb-2 block text-sm text-gray-600 dark:text-gray-400">招募时长:</legend>
                              <div className="automation-recruitment-time-list">
                                {[3, 4].map(star => {
                                  const key = String(star)
                                  const recruitmentTimeId = `${task.id}-recruitment-time-${star}`
                                  const recruitmentTime = task.params.recruitment_time || { '3': 540, '4': 540 }
                                  return (
                                    <label key={star} htmlFor={recruitmentTimeId} className="automation-recruitment-time-row">
                                      <span className="shrink-0 text-sm font-medium text-gray-700 dark:text-gray-200">{star} 星</span>
                                      <input
                                        id={recruitmentTimeId}
                                        type="number"
                                        value={recruitmentTime[key] ?? 540}
                                        onChange={(e) => updateTaskParam(index, 'recruitment_time', { ...recruitmentTime, [key]: e.target.value })}
                                        onBlur={(e) => updateTaskParam(index, 'recruitment_time', {
                                          ...recruitmentTime,
                                          [key]: normalizeRecruitmentTime(e.target.value),
                                        })}
                                        min={RECRUITMENT_TIME_MIN}
                                        max={RECRUITMENT_TIME_MAX}
                                        step={RECRUITMENT_TIME_STEP}
                                        disabled={isRunning || !task.enabled}
                                        className="min-w-0 flex-1 bg-transparent text-right text-sm text-gray-900 outline-hidden dark:text-gray-100"
                                      />
                                      <span className="shrink-0 text-xs text-gray-400">分钟</span>
                                    </label>
                                  )
                                })}
                              </div>
                              <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">可设置 60 至 540 分钟，按 10 分钟调整；五星和六星固定为 540 分钟。</p>
                            </fieldset>
                          </div>
                        </details>
                      )}

                      {/* 启动游戏任务的测试连接按钮 */}
                      {task.commandId === 'startup' && (
                        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-white/10">
                          <Button
                            type="button"
                            fullWidth
                            size="md"
                            variant="secondary"
                            onClick={() => void testConnection(task.id)}
                            disabled={isRunning || !task.enabled || testingConnectionTaskId !== null}
                            loading={isTestingConnection}
                            loadingText="正在检查"
                            statusKey={isTestingConnection ? 'testing' : connectionFeedback?.success ? 'success' : connectionFeedback ? 'error' : 'idle'}
                            icon={connectionFeedback?.success
                              ? <CheckCircle2 size={16} strokeWidth={2.2} aria-hidden="true" />
                              : connectionFeedback
                                ? <AlertTriangle size={16} strokeWidth={2.2} aria-hidden="true" />
                                : <Cable size={16} strokeWidth={2.1} aria-hidden="true" />}
                            aria-busy={isTestingConnection}
                            className={`automation-test-connection${isTestingConnection ? ' is-testing' : ''}`}
                          >
                            {connectionFeedback ? '重新测试' : '测试连接'}
                          </Button>

                          {/* 连接状态显示 */}
                          <AnimatePresence initial={false}>
                            {connectionFeedback && (
                              <motion.div
                                key={task.id}
                                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
                                animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto', y: 0 }}
                                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
                                transition={{ duration: shouldReduceMotion ? 0.08 : 0.18, ease: 'easeOut' }}
                                className={`app-info-card mt-3 flex min-w-0 items-start gap-2 overflow-hidden text-sm ${connectionFeedback.success ? 'status-success' : 'status-danger'}`}
                                role={connectionFeedback.success ? 'status' : 'alert'}
                                aria-live={connectionFeedback.success ? 'polite' : undefined}
                              >
                                {connectionFeedback.success
                                  ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
                                  : <AlertTriangle size={18} className="mt-0.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />}
                                <span className="min-w-0 wrap-break-word leading-5">{connectionFeedback.message}</span>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </SmoothPanel>
          </div>

          <div className="automation-support-column">
            <div className="automation-monitor-column">
              <SmoothPanel
                className="automation-monitor-panel"
                surfaceClassName="automation-monitor-surface"
              >
                <div className="task-monitor-panel is-compact">
                  <ScreenMonitor variant="compact" />
                </div>
              </SmoothPanel>
            </div>

            {schedulePanel}
          </div>
        </div>
        </div>
      </div>

    </>
  )
}
