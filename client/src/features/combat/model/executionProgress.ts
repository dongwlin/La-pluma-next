/**
 * 本次执行进度投影
 *
 * 把当前被跟踪 Run 的服务端事实（`progress` 投影与计时字段）合成本次执行
 * 面板所需的只读视图：状态、作业名、当前关卡、第 N/M 关、逐项状态汇总与
 * 计时来源。单作业（`run_task`）没有逐项与关卡数据时对应字段为 null，
 * 服务端未投影的字段同样降级为 null；模型不推断执行结果，也不读取
 * React、执行控制器或配置。
 */

import type { AgentRun, RunState } from '@/features/task-execution'
import { isActiveRunState } from '@/features/task-execution'
import type { CopilotSetRunProjection } from './copilotSetRun'

/** 作业集逐项状态汇总；单作业或服务端未给出任何条目时为 null。 */
export interface ExecutionProgressCounts {
  success: number
  failed: number
  skipped: number
  pending: number
}

/** 第 N/M 关；服务端未给出总数时 total 为 null。 */
export interface ExecutionProgressStep {
  current: number
  total: number | null
}

export interface ExecutionProgressView {
  runId: string
  operationId: string | null
  state: RunState
  isActive: boolean
  /** 面板顶部状态词；与逐项 counts 分开呈现，不把运行状态当成逐项结果。 */
  stateLabel: string
  /** 作业名：作业集取 Run 名称，单作业取进程任务名。 */
  name: string | null
  /** 正在执行的关卡；等待下一关或单作业执行时为 null。 */
  stage: string | null
  /** 第 N/M 关；只有作业集且服务端给出条目位置时提供。 */
  step: ExecutionProgressStep | null
  counts: ExecutionProgressCounts | null
  /** 活动用法：面板用 startedAtMs 推进已用时；终态直接用 durationMs。 */
  startedAtMs: number | null
  durationMs: number | null
}

const STATE_LABELS: Record<string, string> = {
  accepted: '启动中',
  running: '执行中',
  waiting: '等待下一关',
  stopping: '正在终止',
  succeeded: '已完成',
  failed: '已失败',
  stopped: '已终止',
  interrupted: '已中断',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
}

function readEntryStage(value: unknown): string | null {
  const entry = asRecord(value)
  if (!entry) return null
  return asText(entry.displayStage) ?? asText(entry.stage)
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 读取当前被跟踪 Run 的本次执行进度。Run 缺失时返回 null（面板整块隐藏）；
 * 作业集相关字段只对 `run_copilot_set` 投影，其它操作一律为 null。
 */
export function deriveExecutionProgress(
  run: AgentRun | null,
  setRun: CopilotSetRunProjection | null,
): ExecutionProgressView | null {
  if (!run || typeof run.runId !== 'string' || !run.runId) return null

  const progress = asRecord(run.progress)
  const set = run.operationId === 'run_copilot_set' ? setRun : null
  const state = run.state

  // 作业名：作业集用服务端 Run 名称；单作业回退到进程任务名。
  const name = set
    ? asText(progress?.name) ?? set.name
    : asText(progress?.currentTask)

  const runningEntry = set?.entries.find(entry => entry.status === 'running') ?? null
  const stage = set
    ? readEntryStage(progress?.currentEntry) ?? runningEntry?.stage ?? null
    : null

  let step: ExecutionProgressStep | null = null
  if (set) {
    // 服务端 currentStep/totalSteps 按“本次执行队列”编号（跳过条目不参与），
    // 与逐项 counts 的口径一致；缺失时回退到正在执行条目的作业序号。
    const total = asCount(progress?.totalSteps) ?? (set.totalCount > 0 ? set.totalCount : null)
    const current = asCount(progress?.currentStep)
      ?? (set.currentItemIndex !== null ? set.currentItemIndex + 1 : null)
    if (current !== null && current > 0) {
      step = { current, total }
    }
  }

  // 没有任何条目事实（如刚提交、progress 未投影）时不展示逐项汇总。
  const counts = set && set.totalCount > 0
    ? {
      success: set.successCount,
      failed: set.failedCount,
      skipped: set.skippedCount,
      pending: set.pendingCount,
    }
    : null

  return {
    runId: run.runId,
    operationId: asText(run.operationId),
    state,
    isActive: isActiveRunState(state),
    stateLabel: STATE_LABELS[state] ?? state,
    name,
    stage,
    step,
    counts,
    startedAtMs: readTimestampMs(run.startedAt),
    durationMs: asCount(run.durationMs),
  }
}

/** 已用时文案；缺失或非法输入返回 null，面板不显示该行。 */
export function formatExecutionElapsed(elapsedMs: number | null): string | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}
