/**
 * Dashboard 执行提示
 *
 * 只描述本页发起的日常流程 run 的终态文案；身份归属由执行控制器的
 * `trackedScope` 决定，这里不判断“是不是本页的 run”。
 */

import { isTerminalRunState, type AgentRun } from '@/features/task-execution'
import type { StatusMessageType } from '@/features/runtime-status'

export interface DashboardRunNotice {
  message: string
  type: StatusMessageType
}

function readResultMessage(run: AgentRun): string | null {
  if (!run.result || typeof run.result !== 'object' || Array.isArray(run.result)) return null
  const message = (run.result as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

/** 终态 run 的通知文案；活动或未知身份不产生完成提示。 */
export function describeDashboardRunTerminal(run: AgentRun | null): DashboardRunNotice | null {
  if (!run || !isTerminalRunState(run.state)) return null

  switch (run.state) {
    case 'succeeded':
      return { message: readResultMessage(run) || '今日流程执行完成', type: 'success' }
    case 'stopped':
      return { message: readResultMessage(run) || '今日流程已终止', type: 'warning' }
    case 'failed':
      return { message: `今日流程执行失败: ${run.error?.message || '未能完成'}`, type: 'error' }
    default:
      return {
        message: `任务已中断: ${run.error?.message || '服务重启后无法确认执行结果'}`,
        type: 'warning',
      }
  }
}
