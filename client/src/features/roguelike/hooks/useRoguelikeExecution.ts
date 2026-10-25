/**
 * 肉鸽执行接线
 *
 * 页面只订阅统一执行控制器的快照并发送启动/停止意图：
 * - 运行状态来自服务端 Run，不在页面内维护第二份执行状态机；
 * - 提交使用应用级控制器的幂等 intent，重复点击不会并发提交；
 * - 停止按本客户端持有的 runId 进行，确认期间由快照推进，页面隐藏/恢复不会遗留锁定按钮；
 * - `scope` 标记 run 的领域归属，避免把其它页面发起的 run 展示成肉鸽执行。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '@/shared/api'
import type { StatusMessageType } from '@/features/runtime-status'
import {
  executionController as defaultExecutionController,
  executePredefinedTask,
  isActiveRunState,
  isTerminalRunState,
  readSubmittedRunId,
  useExecutionSnapshot,
  type AgentRun,
  type ExecutionController,
} from '@/features/task-execution'

export const ROGUELIKE_EXECUTION_SCOPE = 'roguelike'

/** 停止请求成功但 run 长期没有离开 running 时，解锁按钮允许重试。 */
export const ROGUELIKE_STOP_CONFIRM_TIMEOUT_MS = 15_000

export interface RoguelikeExecutionRequest {
  command: string
  params: string
  taskName: string
}

export interface RoguelikeExecution {
  /** 本页发起且仍处于活动状态的 run，或身份已持久化但快照尚未解析出来。 */
  isRunning: boolean
  /** 停止确认中：服务端已进入 stopping，或停止请求已成功等待终态。 */
  isStopping: boolean
  /** 启动请求在途；按钮保持禁用，重复点击不会产生第二个提交。 */
  isSubmitting: boolean
  execute: (request: RoguelikeExecutionRequest) => Promise<void>
  stop: () => Promise<void>
}

interface UseRoguelikeExecutionOptions {
  notify: (message: string, type?: StatusMessageType) => void
  controller?: ExecutionController
}

function describeTerminalRun(run: AgentRun, label: string | undefined): { message: string; type: StatusMessageType } {
  if (run.state === 'succeeded') {
    return { message: label ? `${label} 执行成功` : '肉鸽任务执行成功', type: 'success' }
  }
  if (run.state === 'stopped') return { message: '肉鸽任务已终止', type: 'warning' }
  if (run.state === 'failed') {
    return { message: `执行失败: ${run.error?.message || '任务未能完成'}`, type: 'error' }
  }
  return {
    message: `任务已中断: ${run.error?.message || '服务重启后无法确认执行结果'}`,
    type: 'warning',
  }
}

export function useRoguelikeExecution({
  notify,
  controller = defaultExecutionController,
}: UseRoguelikeExecutionOptions): RoguelikeExecution {
  const execution = useExecutionSnapshot(controller)
  const owned = execution.trackedScope === ROGUELIKE_EXECUTION_SCOPE
  const ownedRunId = owned ? execution.trackedRunId : null
  const trackedRun = owned ? execution.trackedRun : null
  const activeRun = trackedRun && isActiveRunState(trackedRun.state) ? trackedRun : null
  // 身份已持久化但快照还没返回：保守地按运行中处理，刷新后不能因此重复提交。
  const unresolved = owned && Boolean(ownedRunId) && execution.identity === 'tracked' && !trackedRun
  const isRunning = Boolean(activeRun) || unresolved
  const isSubmitting = execution.submission === 'pending'

  const [stopRequestPending, setStopRequestPending] = useState(false)
  const [stopAcknowledged, setStopAcknowledged] = useState(false)
  const stopRequestRef = useRef(false)
  const lastOwnedRunIdRef = useRef<string | null>(null)
  const observedActiveRunRef = useRef<string | null>(null)
  const announcedRunRef = useRef<string | null>(null)
  const runLabelsRef = useRef(new Map<string, string>())

  // 新 run 身份出现或解除时，停止确认状态属于上一个 run，不能沿用到新一次执行。
  // 用 ref 比较而不是只在依赖变化时重置：Activity 恢复会重新执行全部 Effects。
  useEffect(() => {
    if (lastOwnedRunIdRef.current === ownedRunId) return
    lastOwnedRunIdRef.current = ownedRunId
    setStopRequestPending(false)
    setStopAcknowledged(false)
    stopRequestRef.current = false
  }, [ownedRunId])

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
    announcedRunRef.current = trackedRun.runId
    const label = runLabelsRef.current.get(trackedRun.runId)
    const terminal = describeTerminalRun(trackedRun, label)
    notify(terminal.message, terminal.type)
  }, [activeRun, notify, ownedRunId, trackedRun])

  useEffect(() => {
    if (!stopAcknowledged || !isRunning) return
    // 服务端已经进入 stopping 时继续等待终态；只有仍显示 running 或状态未知才解锁。
    if (trackedRun?.state === 'stopping') return

    const timer = window.setTimeout(() => {
      setStopAcknowledged(false)
      notify('终止失败: 终止请求已发送，但尚未确认任务停止', 'error')
    }, ROGUELIKE_STOP_CONFIRM_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [isRunning, notify, stopAcknowledged, trackedRun?.state])

  const execute = useCallback(async ({ command, params, taskName }: RoguelikeExecutionRequest) => {
    if (isRunning || controller.getState().submission === 'pending') return

    notify('正在执行命令...')
    try {
      const result = await controller.submitExecution(
        'run_task',
        ({ idempotencyKey }) => executePredefinedTask(
          command,
          params,
          null,
          null,
          taskName,
          'roguelike',
          false,
          { idempotencyKey },
        ),
        { scope: ROGUELIKE_EXECUTION_SCOPE },
      )

      if (!result.success) {
        notify(`执行失败: ${getErrorMessage(result)}`, 'error')
        return
      }

      const runId = readSubmittedRunId(result.data)
      if (runId) runLabelsRef.current.set(runId, taskName)
      else notify(`${taskName} 已提交`, 'info')
    } catch (error) {
      // 传输失败时服务端可能已经接受执行，不能宣称失败或自动重提。
      notify(`无法确认执行状态: ${(error as Error).message}`, 'warning')
    }
  }, [controller, isRunning, notify])

  const stop = useCallback(async () => {
    if (stopRequestRef.current) return
    if (!controller.getState().trackedRunId) return

    stopRequestRef.current = true
    setStopRequestPending(true)
    notify('正在终止肉鸽任务...', 'warning')

    try {
      const result = await controller.stopTrackedRun()
      if (!result) {
        notify('未找到可终止的肉鸽运行', 'warning')
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

  const isStopping = isRunning
    && (trackedRun?.state === 'stopping' || stopRequestPending || stopAcknowledged)

  return { isRunning, isStopping, isSubmitting, execute, stop }
}
