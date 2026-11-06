// 设置域更新命令的 Run 观察端口：提交后采纳服务端 runId，按控制器已持有的
// 快照等待终态，并把停止映射为目标 run 的停止请求。没有 runId 的旧同步响应
// 保持原语义，不伪造执行身份。

import {
  executionController,
  isTerminalRunState,
  type AgentRun,
  type ExecutionController,
} from '@/features/task-execution'
import { isRecord, type ApiResponse } from '@/shared/api'

export type UpdateRunTerminalState =
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'unknown'

export interface UpdateRunTerminal {
  readonly state: UpdateRunTerminalState
  readonly message: string | null
  readonly errorCode: string | null
  readonly errorDetails: Record<string, unknown>
}

export interface SettingsUpdateRunPort {
  /** 采纳响应中的 runId 并让全局控制器观察它；旧同步响应返回 null。 */
  adopt(response: ApiResponse, operationId: string): string | null
  /** 等待目标 run 进入终态；身份丢失或无法确认时返回 unknown。 */
  wait(runId: string): Promise<UpdateRunTerminal>
  /** 服务端执行结束或失败后解除本域身份；只解除仍属于该 run 的身份。 */
  release(runId: string): void
  /** 拒绝未知状态时不退化为旧式“停止当前任务”。 */
  cancel(runId: string): Promise<ApiResponse<unknown> | null>
}

export const SETTINGS_UPDATE_SCOPE = 'settings'

/** 本域只使用控制器的身份采纳、观察与目标停止能力，测试可注入独立实例。 */
export type SettingsUpdateRunController = Pick<
  ExecutionController,
  'adoptSubmission' | 'getState' | 'subscribe' | 'observeRun' | 'stopTrackedRun'
>

const UNKNOWN_TERMINAL: UpdateRunTerminal = {
  state: 'unknown',
  message: null,
  errorCode: null,
  errorDetails: {},
}

/**
 * 等待上限：身份失效会立即结算；这个上限只兜底控制器长时间无法确认终态的场景
 * （例如页面从未恢复观察），避免命令槽位和“执行中”提示永久不结束。更新安装
 * 可能持续十几分钟，因此不能取更短的值。
 */
export const SETTINGS_UPDATE_RUN_WAIT_TIMEOUT_MS = 30 * 60_000

function terminalOf(run: AgentRun): UpdateRunTerminal {
  if (!isTerminalRunState(run.state)) return UNKNOWN_TERMINAL
  const message = typeof run.error?.message === 'string' ? run.error.message : null
  const errorCode = typeof run.error?.code === 'string' ? run.error.code : null
  const errorDetails = isRecord(run.error?.details) ? run.error.details : {}
  return { state: run.state, message, errorCode, errorDetails }
}

export function createSettingsUpdateRunPort(
  controller: SettingsUpdateRunController = executionController,
): SettingsUpdateRunPort {
  return {
    adopt(response, operationId) {
      return controller.adoptSubmission(response, operationId, {
        scope: SETTINGS_UPDATE_SCOPE,
      })
    },

    wait(runId) {
      return new Promise<UpdateRunTerminal>(resolve => {
        let unsubscribe: () => void = () => undefined
        let timer: ReturnType<typeof setTimeout> | null = null
        let settled = false
        const finish = (terminal: UpdateRunTerminal) => {
          if (settled) return
          settled = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          unsubscribe()
          resolve(terminal)
        }
        const read = () => {
          const state = controller.getState()
          if (state.trackedRunId !== runId) {
            finish(UNKNOWN_TERMINAL)
            return
          }
          const run = state.trackedRun
          if (run && isTerminalRunState(run.state)) {
            finish(terminalOf(run))
            return
          }
          // 服务端按 id 查不到该 run 时控制器只标记 identity=unknown，仍保留
          // trackedRunId 与最后一次快照；不在这里结算就会一直等下去。
          if (state.identity !== 'tracked') finish(UNKNOWN_TERMINAL)
        }
        unsubscribe = controller.subscribe(read)
        read()
        if (!settled) {
          timer = setTimeout(() => finish(UNKNOWN_TERMINAL), SETTINGS_UPDATE_RUN_WAIT_TIMEOUT_MS)
        }
      })
    },

    release(runId) {
      if (controller.getState().trackedRunId !== runId) return
      controller.observeRun(null)
    },

    async cancel(runId) {
      if (controller.getState().trackedRunId !== runId) return null
      return controller.stopTrackedRun()
    },
  }
}
