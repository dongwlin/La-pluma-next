/**
 * 自动战斗执行接线
 *
 * 页面只订阅统一执行控制器的快照并发送启动/继续/停止意图：
 * - 单作业与作业集都走服务端 Run，页面不再按 generation 编排连续执行；
 * - 作业集三模式映射为服务端 `continuous`/`manual`，逐项结果与失败汇总来自 Run；
 * - manual 的“开始下一关”只是继续请求，等待态与下一项都由服务端持有；
 * - 停止按本客户端持有的 runId 进行，确认期间由快照推进，页面隐藏/恢复不会遗留锁定按钮；
 * - `scope` 标记 run 的领域归属，避免把其它页面发起的 run 展示成自动战斗执行。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '@/shared/api'
import type { StatusMessageType } from '@/features/runtime-status'
import {
  executionController as defaultExecutionController,
  executePredefinedTaskArgs,
  isActiveRunState,
  isTerminalRunState,
  readSubmittedRun,
  readSubmittedRunId,
  useExecutionSnapshot,
  type AgentRun,
  type ExecutionController,
} from '@/features/task-execution'
import { continueCopilotSet, executeCopilotSetPlan, type CopilotSetRunMode } from '../api'
import {
  describeCombatTaskTerminal,
  describeCopilotSetRunTerminal,
  readCopilotSetRunProjection,
  type CopilotSetEntryProjection,
  type CopilotSetRunProjection,
} from '../model/copilotSetRun'

export const COMBAT_EXECUTION_SCOPE = 'combat'

/** 停止请求成功但 run 长期没有离开 running 时，解锁按钮允许重试。 */
export const COMBAT_STOP_CONFIRM_TIMEOUT_MS = 15_000

export interface CombatTaskSubmission {
  command: string
  args: string[]
  taskName: string
  /** 页面对当前单作业展示用的输入摘要，只用于本地提示。 */
  inputSummary?: string
}

export interface CombatSetSubmission {
  setId: string
  /** 服务端模式；页面的 `app`/`cli` 都映射为 `continuous`。 */
  mode: CopilotSetRunMode
  raid: 'normal' | 'raid' | 'both'
  selectedIndexes: number[]
  options: Record<string, unknown>
  taskName: string
}

export interface CombatExecution {
  /** 本页发起且仍处于活动的 run（含等待下一关），或身份已持久化但快照尚未解析出来。 */
  isRunning: boolean
  /** manual 作业集正在等待“开始下一关”。 */
  isWaitingForNext: boolean
  /** 按队列策略自动停止期间，不再展示可点击的“开始下一关”。 */
  isAutoStopping: boolean
  /** 停止确认中：服务端已进入 stopping，或停止请求已成功等待终态。 */
  isStopping: boolean
  /** 继续下一关的请求在途；按钮保持禁用，重复点击不会并发提交。 */
  isContinuing: boolean
  /** 提交请求在途；按钮保持禁用，重复点击不会产生第二个提交。 */
  isSubmitting: boolean
  /** 本页所属作业集 run 的投影；单作业运行或其它领域 run 时为 null。 */
  setRun: CopilotSetRunProjection | null
  /** 本页所属 run 的最近记录，用于展示阶段与错误。 */
  run: AgentRun | null
  submitTask: (request: CombatTaskSubmission) => Promise<boolean>
  submitSet: (request: CombatSetSubmission) => Promise<boolean>
  continueSet: () => Promise<void>
  stop: () => Promise<void>
}

interface UseCombatExecutionOptions {
  notify: (message: string, type?: StatusMessageType) => void
  /** 作业集 manual 模式条目失败后是否按“失败后停止”策略结束 run。 */
  stopOnFailure?: boolean
  controller?: ExecutionController
}

function isSettledEntry(entry: CopilotSetEntryProjection): boolean {
  return entry.status === 'success' || entry.status === 'failed' || entry.status === 'stopped'
}

/** manual 等待态下最近结算的条目：按作业顺序取最后一个，同作业优先失败。 */
function latestSettledEntry(projection: CopilotSetRunProjection): CopilotSetEntryProjection | null {
  const settled = projection.entries.filter(isSettledEntry)
  if (!settled.length) return null
  const lastIndex = Math.max(...settled.map(entry => entry.itemIndex ?? -1))
  const lastEntries = settled.filter(entry => (entry.itemIndex ?? -1) === lastIndex)
  return lastEntries.find(entry => entry.status === 'failed') ?? lastEntries[0] ?? null
}

function describeSettledEntry(entry: CopilotSetEntryProjection, projection: CopilotSetRunProjection) {
  const position = entry.itemIndex === null
    ? '作业'
    : `作业 ${entry.itemIndex + 1}/${Math.max(projection.itemCount, 1)}`
  if (entry.status === 'failed') {
    return `${position} 执行失败: ${entry.error || '未知错误'}`
  }
  if (entry.status === 'stopped') {
    return `${position} 已终止`
  }
  return `${position} 完成`
}

export function useCombatExecution({
  notify,
  stopOnFailure = false,
  controller = defaultExecutionController,
}: UseCombatExecutionOptions): CombatExecution {
  const execution = useExecutionSnapshot(controller)
  const owned = execution.trackedScope === COMBAT_EXECUTION_SCOPE
  const ownedRunId = owned ? execution.trackedRunId : null
  const trackedRun = owned ? execution.trackedRun : null
  const activeRun = trackedRun && isActiveRunState(trackedRun.state) ? trackedRun : null
  // 身份已持久化但快照还没返回：保守地按运行中处理，刷新后不能因此重复提交。
  const unresolved = owned && Boolean(ownedRunId) && execution.identity === 'tracked' && !trackedRun
  const isRunning = Boolean(activeRun) || unresolved
  const setRun = readCopilotSetRunProjection(trackedRun)
  const isWaitingForNext = Boolean(setRun?.isWaiting)
  const isSubmitting = execution.submission === 'pending'

  const [stopRequestPending, setStopRequestPending] = useState(false)
  const [stopAcknowledged, setStopAcknowledged] = useState(false)
  const [isContinuing, setIsContinuing] = useState(false)
  const [autoStoppingRunId, setAutoStoppingRunId] = useState<string | null>(null)
  const stopRequestRef = useRef(false)
  const continuingRef = useRef(false)
  const autoStopRef = useRef<string | null>(null)
  const lastOwnedRunIdRef = useRef<string | null>(null)
  const observedActiveRunRef = useRef<string | null>(null)
  const announcedRunRef = useRef<string | null>(null)
  const itemMessageRef = useRef<string | null>(null)
  const waitingMessageRef = useRef<string | null>(null)
  const runLabelsRef = useRef(new Map<string, string>())

  // 新 run 身份出现或解除时，停止/继续/自动停止状态属于上一个 run，不能沿用到新一次执行。
  // 用 ref 比较而不是只在依赖变化时重置：Activity 恢复会重新执行全部 Effects。
  useEffect(() => {
    if (lastOwnedRunIdRef.current === ownedRunId) return
    lastOwnedRunIdRef.current = ownedRunId
    setStopRequestPending(false)
    setStopAcknowledged(false)
    setAutoStoppingRunId(null)
    stopRequestRef.current = false
    continuingRef.current = false
    autoStopRef.current = null
  }, [ownedRunId])

  const announceTerminal = useCallback((run: AgentRun) => {
    announcedRunRef.current = run.runId
    const projection = readCopilotSetRunProjection(run)
    const notice = projection
      ? describeCopilotSetRunTerminal(run, projection)
      : describeCombatTaskTerminal(run, runLabelsRef.current.get(run.runId))
    notify(notice.message, notice.type)
  }, [notify])

  useEffect(() => {
    if (!ownedRunId) return
    if (activeRun) {
      observedActiveRunRef.current = activeRun.runId
      return
    }
    if (!trackedRun || !isTerminalRunState(trackedRun.state)) return
    // 只宣告本次页面实际观察过活动的 run；刷新后直接看到终态时不重复提示。
    if (observedActiveRunRef.current !== trackedRun.runId) return
    if (announcedRunRef.current === trackedRun.runId) return

    observedActiveRunRef.current = null
    announceTerminal(trackedRun)
  }, [activeRun, announceTerminal, ownedRunId, trackedRun])

  // 作业集逐项进度：服务端切换当前项时给一次短提示，不驱动任何执行决策。
  useEffect(() => {
    if (!setRun?.isActive || setRun.currentItemIndex === null) return
    const key = `${setRun.runId}:${setRun.currentItemIndex}`
    if (itemMessageRef.current === key) return
    itemMessageRef.current = key
    const entry = setRun.entries.find(item => item.status === 'running')
    const stage = entry?.stage ? `: ${entry.stage}` : ''
    notify(`正在执行作业 ${setRun.currentItemIndex + 1}/${Math.max(setRun.itemCount, 1)}${stage}`)
  }, [notify, setRun])

  const stop = useCallback(async () => {
    if (stopRequestRef.current) return
    if (!controller.getState().trackedRunId) return

    stopRequestRef.current = true
    setStopRequestPending(true)
    notify('正在终止自动战斗...', 'warning')

    try {
      const result = await controller.stopTrackedRun()
      if (!result) {
        notify('未找到可终止的自动战斗运行', 'warning')
        setStopAcknowledged(false)
        return
      }
      if (!result.success) {
        notify(`终止失败: ${getErrorMessage(result)}`, 'error')
        setStopAcknowledged(false)
        return
      }
      setStopAcknowledged(!result.data?.alreadyTerminal)
    } catch (error) {
      notify(`终止失败: ${(error as Error).message}`, 'error')
      setStopAcknowledged(false)
    } finally {
      stopRequestRef.current = false
      setStopRequestPending(false)
    }
  }, [controller, notify])

  useEffect(() => {
    if (!stopAcknowledged || !isRunning) return
    // 服务端已经进入 stopping 时继续等待终态；只有仍显示 running 或状态未知才解锁。
    if (trackedRun?.state === 'stopping') return

    const timer = window.setTimeout(() => {
      setStopAcknowledged(false)
      notify('终止失败: 终止请求已发送，但尚未确认任务停止', 'error')
    }, COMBAT_STOP_CONFIRM_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [isRunning, notify, stopAcknowledged, trackedRun?.state])

  // manual 作业集在“失败后停止”策略下结束等待态；继续请求在途时不介入，避免停掉刚启动的下一关。
  useEffect(() => {
    if (!stopOnFailure || !setRun?.isWaiting) {
      if (autoStoppingRunId) setAutoStoppingRunId(null)
      return
    }
    if (continuingRef.current || stopRequestRef.current) return

    const failed = latestSettledEntry(setRun)
    if (!failed || failed.status !== 'failed') return
    const key = `${setRun.runId}:${failed.key ?? failed.itemIndex}`
    if (autoStopRef.current === key) return

    autoStopRef.current = key
    setAutoStoppingRunId(setRun.runId)
    notify(`${describeSettledEntry(failed, setRun)}，已按队列策略停止`, 'error')
    void stop()
  }, [autoStoppingRunId, notify, setRun, stop, stopOnFailure])

  // manual 等待态提示与“下一项”说明只描述服务端事实。
  useEffect(() => {
    if (!setRun?.isWaiting) {
      waitingMessageRef.current = null
      return
    }
    const settled = latestSettledEntry(setRun)
    if (!settled) return
    // 失败后停止策略会紧接着结束 run，不再提示“等待开始下一关”。
    if (stopOnFailure && settled.status === 'failed') return
    const key = `${setRun.runId}:${settled.key ?? settled.itemIndex}:${settled.status}`
    if (waitingMessageRef.current === key) return
    waitingMessageRef.current = key
    notify(`${describeSettledEntry(settled, setRun)}，等待开始下一关`)
  }, [notify, setRun, stopOnFailure])

  const submitTask = useCallback(async ({ command, args, taskName }: CombatTaskSubmission) => {
    if (isRunning || controller.getState().submission === 'pending') return false

    notify(`正在执行: ${taskName}`)
    try {
      const result = await controller.submitExecution(
        'run_task',
        ({ idempotencyKey }) => executePredefinedTaskArgs(
          command,
          args,
          null,
          null,
          taskName,
          'combat',
          false,
          { idempotencyKey },
        ),
        { scope: COMBAT_EXECUTION_SCOPE },
      )

      if (!result.success) {
        notify(`执行失败: ${getErrorMessage(result)}`, 'error')
        return false
      }

      const runId = readSubmittedRunId(result.data)
      if (runId) runLabelsRef.current.set(runId, taskName)
      const submittedRun = runId ? readSubmittedRun(result.data, runId) : null
      if (submittedRun && isTerminalRunState(submittedRun.state)) announceTerminal(submittedRun)
      return true
    } catch (error) {
      // 传输失败时服务端可能已经接受执行，不能宣称失败或自动重提。
      notify(`无法确认执行状态: ${(error as Error).message}`, 'warning')
      return false
    }
  }, [announceTerminal, controller, isRunning, notify])

  const submitSet = useCallback(async (request: CombatSetSubmission) => {
    if (isRunning || controller.getState().submission === 'pending') return false
    if (!request.selectedIndexes.length) {
      notify('请至少选择一个作业', 'warning')
      return false
    }

    notify(request.mode === 'manual' ? '正在执行作业集（手动逐关）' : '正在连续执行作业集')
    try {
      const result = await controller.submitExecution(
        'run_copilot_set',
        ({ idempotencyKey }) => executeCopilotSetPlan(request.setId, {
          raid: request.raid,
          selectedIndexes: request.selectedIndexes,
          options: request.options,
          mode: request.mode,
          waitForCompletion: false,
        }, { idempotencyKey }),
        { scope: COMBAT_EXECUTION_SCOPE },
      )

      if (!result.success) {
        notify(`作业集执行失败: ${getErrorMessage(result)}`, 'error')
        return false
      }

      const runId = readSubmittedRunId(result.data)
      if (runId) runLabelsRef.current.set(runId, request.taskName)
      const submittedRun = runId ? readSubmittedRun(result.data, runId) : null
      if (submittedRun && isTerminalRunState(submittedRun.state)) announceTerminal(submittedRun)
      return true
    } catch (error) {
      notify(`无法确认作业集执行状态: ${(error as Error).message}`, 'warning')
      return false
    }
  }, [announceTerminal, controller, isRunning, notify])

  const continueSet = useCallback(async () => {
    if (continuingRef.current) return
    const state = controller.getState()
    if (state.trackedScope !== COMBAT_EXECUTION_SCOPE || !state.trackedRunId) return

    continuingRef.current = true
    setIsContinuing(true)
    notify('正在执行下一关...')

    try {
      const result = await continueCopilotSet(state.trackedRunId, { waitForCompletion: false })
      if (!result.success) {
        const code = result.errorInfo?.code
        if (code === 'MAA_EXECUTION_BUSY') {
          notify('设备正被其他任务占用，请稍后重试', 'warning')
        } else if (code === 'AGENT_COPILOT_SET_SESSION_LOST') {
          notify('作业集会话已失效，无法继续下一关，请重新提交作业集', 'error')
        } else if (code === 'AGENT_COPILOT_SET_NOT_WAITING') {
          notify('作业集已不在等待下一关状态，正在重新确认', 'warning')
        } else {
          notify(`继续执行失败: ${getErrorMessage(result)}`, 'error')
        }
        await controller.refresh('manual')
        return
      }

      if (result.data?.alreadyTerminal) notify('作业集已经结束', 'warning')
      await controller.refresh('manual')
    } catch (error) {
      notify(`无法确认下一关状态: ${(error as Error).message}`, 'warning')
    } finally {
      continuingRef.current = false
      setIsContinuing(false)
    }
  }, [controller, notify])

  const isStopping = isRunning
    && (trackedRun?.state === 'stopping' || stopRequestPending || stopAcknowledged)

  return {
    isRunning,
    isWaitingForNext,
    isAutoStopping: Boolean(setRun) && autoStoppingRunId === setRun?.runId,
    isStopping,
    isContinuing,
    isSubmitting,
    setRun,
    run: trackedRun,
    submitTask,
    submitSet,
    continueSet,
    stop,
  }
}
