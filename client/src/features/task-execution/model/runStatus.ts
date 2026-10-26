/**
 * 全局运行状态投影
 *
 * 从执行控制器的唯一快照派生跨页展示需要的运行阶段、身份与一行标签。
 * 它只读控制器状态，不写任何 store，也不是 Run 的副本：调用方不能据此判断
 * 某次执行是否属于自己（归属看控制器的 `trackedScope`）。
 */

import type { ExecutionControllerState } from '../controller/executionController'
import { isActiveRunState, type AgentRun, type RunSnapshot } from '../types'

export type GlobalRunPhase = 'idle' | 'running' | 'waiting' | 'occupied' | 'unknown'

export interface GlobalRunStatus {
  /**
   * 展示阶段：有活动 run 为 `running`/`waiting`；没有 run 但设备被未纳管执行
   * 占用为 `occupied`；观察断线或占用无法判定为 `unknown`。
   */
  phase: GlobalRunPhase
  /** 快照（或已跟踪 run）里仍有活动 run。断线时保留最后已知值，不能当作完成。 */
  isRunning: boolean
  /** 当前或最后已知活动 run 的身份；没有已知身份时为 null。 */
  runId: string | null
  /** 面向用户的短标签；`idle` 时为 null。 */
  label: string | null
  /** 活动 run 自己的进度说明（服务端 `progress.message`）；没有时为 null。 */
  detail: string | null
}

const RUNNING_LABEL = '任务执行中'
const WAITING_LABEL = '等待继续'
const STOPPING_LABEL = '正在停止'
const OCCUPIED_LABEL = '设备被其他任务占用'
const UNKNOWN_LABEL = '执行状态未知'

function readPrimaryRun(snapshot: RunSnapshot | null, trackedRun: AgentRun | null): AgentRun | null {
  if (snapshot?.run && isActiveRunState(snapshot.run.state)) return snapshot.run
  const listed = snapshot?.activeRuns?.find(run => isActiveRunState(run.state))
  if (listed) return listed
  // 身份已恢复但快照还没返回：按最后一次已知状态展示，快照到达后以服务端为准。
  return trackedRun && isActiveRunState(trackedRun.state) ? trackedRun : null
}

function readRunMessage(run: AgentRun): string | null {
  const message = run.progress?.message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

function readRunLabel(run: AgentRun): string {
  if (run.state === 'waiting') return WAITING_LABEL
  if (run.state === 'stopping') return STOPPING_LABEL
  const task = run.progress?.currentTask
  return typeof task === 'string' && task.trim() ? `正在执行: ${task.trim()}` : RUNNING_LABEL
}

export function summarizeRunStatus(state: ExecutionControllerState): GlobalRunStatus {
  const run = readPrimaryRun(state.snapshot, state.trackedRun)
  const isRunning = Boolean(run) || Boolean(state.snapshot?.activeRuns?.length)
  const runId = run?.runId ?? null

  // 网络离线或观察断线都保留最后已知的运行事实，但展示必须标明状态未知，
  // 不能继续冒充“正在运行”，也不能据此推断完成。
  if (state.phase === 'disconnected' || state.phase === 'offline') {
    return { phase: 'unknown', isRunning, runId, label: UNKNOWN_LABEL, detail: null }
  }

  if (run) {
    return {
      phase: run.state === 'waiting' ? 'waiting' : 'running',
      isRunning,
      runId,
      label: readRunLabel(run),
      detail: readRunMessage(run),
    }
  }

  if (state.occupancy?.state === 'external') {
    return { phase: 'occupied', isRunning: false, runId: null, label: OCCUPIED_LABEL, detail: null }
  }

  if (state.occupancy?.state === 'unknown') {
    return { phase: 'unknown', isRunning: false, runId: null, label: UNKNOWN_LABEL, detail: null }
  }

  return { phase: 'idle', isRunning: false, runId: null, label: null, detail: null }
}
