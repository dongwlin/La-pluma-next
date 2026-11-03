/**
 * 本次执行进度投影
 *
 * 把当前被跟踪 Run 的服务端事实（`progress` 投影与计时字段）合成本次执行
 * 面板所需的只读视图：作业名、当前关卡、本次第 N/M 个执行条目与计时来源。
 *
 * 面板只补充其它展示位置没有的进度事实：运行状态与停止入口属于执行卡片，
 * 逐项结果属于作业列表与续跑进度，因此这里不再投影状态词与逐项计数。单作业
 * （`run_task`）没有条目位置与关卡数据时对应字段为 null，服务端未投影的
 * 字段同样降级为 null；模型不推断执行结果，也不读取 React、执行控制器或配置。
 */

import type { AgentRun, RunState } from '@/features/task-execution'
import { isActiveRunState } from '@/features/task-execution'
import type { CopilotSetRunProjection } from './copilotSetRun'

/**
 * 本次执行的条目位置：`current` 与 `total` 都按本次执行队列（跳过条目不参与）
 * 计数，一个 both 作业的普通与突袭条目各占一位，与“关数”不同。
 */
export interface ExecutionProgressStep {
  current: number
  total: number | null
}

export interface ExecutionProgressView {
  runId: string
  operationId: string | null
  state: RunState
  isActive: boolean
  /** 单作业的进程任务名；作业集名称由续跑进度与列表负责，面板不重复展示。 */
  name: string | null
  /** 正在执行的关卡；等待下一关或单作业执行时为 null。 */
  stage: string | null
  /** 本次第 N/M 个执行条目；只有作业集且服务端给出队列位置时提供。 */
  step: ExecutionProgressStep | null
  /** 活动用法：面板用 startedAtMs 推进已用时；终态直接用 durationMs。 */
  startedAtMs: number | null
  durationMs: number | null
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

  // 作业名只用于没有条目进度的单作业；作业集名称由列表与续跑进度展示。
  const name = set ? null : asText(progress?.currentTask)

  const runningEntry = set?.entries.find(entry => entry.status === 'running') ?? null
  const stage = set
    ? readEntryStage(progress?.currentEntry) ?? runningEntry?.stage ?? null
    : null

  // 条目位置只取服务端的队列编号：作业条目索引在 both 模式下与执行序号不同，
  // 不能互相替代。
  let step: ExecutionProgressStep | null = null
  if (set) {
    const current = asCount(progress?.currentStep)
    if (current !== null && current > 0) {
      step = { current, total: asCount(progress?.totalSteps) }
    }
  }

  return {
    runId: run.runId,
    operationId: asText(run.operationId),
    state,
    isActive: isActiveRunState(state),
    name,
    stage,
    step,
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
