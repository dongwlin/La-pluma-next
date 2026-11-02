/**
 * 全局执行状态条的活动 Run 展示投影
 *
 * 只读执行控制器状态，不写任何 store，也不判断执行归属：归属仍由
 * `trackedScope` 判定，这里只回答「当前有没有活动 Run、它在干什么」。
 * 字段缺失时逐级降级为通用「执行中」文案，不伪造服务端没有的进度。
 */

import { getErrorMessage } from '@/shared/api'
import { stopRun } from '../api'
import type { ExecutionController, ExecutionControllerState } from '../controller/executionController'
import { isActiveRunState, type ActiveRunState, type RunProgress } from '../types'
import { findPrimaryActiveRun } from './runStatus'

const GENERIC_EXECUTING_LABEL = '执行中'
const DAILY_FLOW_OPERATION_ID = 'run_daily_flow'
const DAILY_FLOW_LABEL = '日常流程'
const COPILOT_SET_OPERATION_ID = 'run_copilot_set'
const WAITING_PHASE_LABEL = '等待继续'
const ACCEPTED_PHASE_LABEL = '等待开始'
const UNKNOWN_PHASE_LABEL = '执行状态未知'

/** 状态条展示的活动执行视图；没有活动 Run 时为 null。 */
export interface ActiveExecutionView {
  runId: string
  state: ActiveRunState
  /** 任务名或阶段：作业集名 / 日常流程步数 / 任务名；缺失时降级为通用「执行中」。 */
  title: string
  /** 当前作业或关卡；没有更具体条目时为 null。 */
  currentEntry: string | null
  /** 服务端进度说明（`progress.message`），作为次级说明展示。 */
  message: string | null
  /** 活动 Run 的起始毫秒时间戳；没有 `startedAt` 时回退 `acceptedAt`。 */
  startedAt: number | null
  /** 已请求停止；终止入口转为进行中展示。 */
  isStopping: boolean
  /** 非常规运行态或断线时的短标签；常规 running 为 null。 */
  phaseLabel: string | null
}

function readTrimmedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 作业集条目只取服务端已拼好的展示字段，不猜对象形状以外的内容。 */
function readEntryStage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as { displayStage?: unknown; title?: unknown; stageId?: unknown }
  return readTrimmedText(entry.displayStage) ?? readTrimmedText(entry.title) ?? readTrimmedText(entry.stageId)
}

function readStepProgress(progress: RunProgress, unit: string): string | null {
  const current = progress.currentStep
  const total = progress.totalSteps
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 1) return null
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 1) return null
  return `第 ${Math.min(current, total)}/${total} ${unit}`
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * 活动执行展示投影：主标题按作业集名 → 日常流程阶段 → 任务名 → 通用文案降级；
 * 当前作业或关卡取 `currentTask`（与主标题重复时省略），缺失时回退条目关卡号。
 */
export function readActiveExecutionView(state: ExecutionControllerState): ActiveExecutionView | null {
  const run = findPrimaryActiveRun(state.snapshot, state.trackedRun)
  if (!run || !isActiveRunState(run.state)) return null

  const progress: RunProgress = run.progress ?? {}
  const currentTask = readTrimmedText(progress.currentTask)

  let title = GENERIC_EXECUTING_LABEL
  if (run.operationId === COPILOT_SET_OPERATION_ID) {
    const name = readTrimmedText(progress.name)
    if (name) {
      const stepText = readStepProgress(progress, '项')
      title = stepText ? `${name} ${stepText}` : name
    } else if (currentTask) {
      title = currentTask
    }
  } else if (run.operationId === DAILY_FLOW_OPERATION_ID) {
    const stepText = readStepProgress(progress, '步')
    title = stepText ? `${DAILY_FLOW_LABEL} ${stepText}` : DAILY_FLOW_LABEL
  } else if (currentTask) {
    title = currentTask
  }

  const stage = readEntryStage(progress.currentEntry)
  let currentEntry: string | null = null
  if (currentTask && currentTask !== title) currentEntry = currentTask
  else if (!currentTask) currentEntry = stage

  const disconnected = state.phase === 'disconnected' || state.phase === 'offline'
  const phaseLabel = disconnected
    ? UNKNOWN_PHASE_LABEL
    : run.state === 'waiting'
      ? WAITING_PHASE_LABEL
      : run.state === 'accepted'
        ? ACCEPTED_PHASE_LABEL
        : null

  return {
    runId: run.runId,
    state: run.state,
    title,
    currentEntry,
    message: readTrimmedText(progress.message),
    startedAt: readTimestamp(run.startedAt) ?? readTimestamp(run.acceptedAt),
    isStopping: run.state === 'stopping',
    phaseLabel,
  }
}

/** 已用时格式化：不足一小时显示 m:ss，超过后显示 h:mm:ss。 */
export function formatExecutionElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const twoDigits = (value: number) => value.toString().padStart(2, '0')
  if (hours > 0) return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
  return `${minutes}:${twoDigits(seconds)}`
}

/**
 * 终止状态条正在展示的活动 Run。Run 属于本客户端身份时走控制器的目标停止
 * （由它收敛停止响应并刷新快照）；否则直接调用既有按 runId 目标停止端点，
 * 再让控制器刷新快照。失败抛错交给确认框展示，不另起一套通知体系。
 */
export async function stopActiveExecutionRun(
  controller: ExecutionController,
  runId: string,
): Promise<void> {
  const tracked = controller.getState()
  if (tracked.identity === 'tracked' && tracked.trackedRunId === runId) {
    const result = await controller.stopTrackedRun()
    if (!result) throw new Error('未找到可终止的执行')
    if (!result.success) throw new Error(getErrorMessage(result))
    return
  }

  const result = await stopRun(runId)
  if (!result.success) throw new Error(getErrorMessage(result))
  await controller.refresh('manual')
}
