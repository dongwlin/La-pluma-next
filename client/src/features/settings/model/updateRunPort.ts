// 设置域更新命令的 Run 观察端口：提交后采纳服务端 runId，按控制器已持有的
// 快照等待终态，并把停止映射为目标 run 的停止请求。没有 runId 的旧同步响应
// 保持原语义，不伪造执行身份。

import {
  executionController,
  isTerminalRunState,
  type AgentRun,
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

const UNKNOWN_TERMINAL: UpdateRunTerminal = {
  state: 'unknown',
  message: null,
  errorCode: null,
  errorDetails: {},
}

function terminalOf(run: AgentRun): UpdateRunTerminal {
  if (!isTerminalRunState(run.state)) return UNKNOWN_TERMINAL
  const message = typeof run.error?.message === 'string' ? run.error.message : null
  const errorCode = typeof run.error?.code === 'string' ? run.error.code : null
  const errorDetails = isRecord(run.error?.details) ? run.error.details : {}
  return { state: run.state, message, errorCode, errorDetails }
}

export function createSettingsUpdateRunPort(): SettingsUpdateRunPort {
  return {
    adopt(response, operationId) {
      return executionController.adoptSubmission(response, operationId, {
        scope: SETTINGS_UPDATE_SCOPE,
      })
    },

    wait(runId) {
      return new Promise<UpdateRunTerminal>(resolve => {
        let unsubscribe: () => void = () => undefined
        const finish = (terminal: UpdateRunTerminal) => {
          unsubscribe()
          resolve(terminal)
        }
        const read = () => {
          const state = executionController.getState()
          if (state.trackedRunId !== runId) {
            finish(UNKNOWN_TERMINAL)
            return
          }
          const run = state.trackedRun
          if (!run || !isTerminalRunState(run.state)) return
          finish(terminalOf(run))
        }
        unsubscribe = executionController.subscribe(read)
        read()
      })
    },

    release(runId) {
      if (executionController.getState().trackedRunId !== runId) return
      executionController.observeRun(null)
    },

    async cancel(runId) {
      if (executionController.getState().trackedRunId !== runId) return null
      return executionController.stopTrackedRun()
    },
  }
}
