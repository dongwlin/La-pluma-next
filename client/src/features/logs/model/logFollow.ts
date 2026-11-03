/**
 * 实时日志智能跟随状态机
 *
 * 手动「自动滚动」开关之外的第二层：开关打开时，用户离开滚动容器底部会
 * 临时暂停跟随并开始累计新增行数，回到底部或点击未读指示即恢复。手动
 * 开关关闭=永不跟随，此时组件不驱动本状态机；本模块不感知 DOM 与轮询，
 * 只裁决事件后的跟随状态。
 *
 * 到达检测以源记录身份为准，相同快照、仅移除旧记录都不会产生未读。
 * 旧服务端没有事件 ID 时以内容多重集合降级检测；窗口外的记录不可回补，
 * 因此界面只提示有新日志，不承诺精确的到达总数。
 */

import type { LogEntry } from '../types'
import { getLogIdentity } from './logModel'

export interface LogFollowState {
  /** 智能暂停：用户离开底部后为 true，滚动 Effect 与未读指示以此为准。 */
  readonly paused: boolean
  /** 暂停以来累计的新增行数；恢复跟随即清零。 */
  readonly pendingCount: number
}

export type LogFollowAction =
  /** 用户滚动离开底部；已暂停时保持现有计数不变。 */
  | { type: 'leave-bottom' }
  /** 回到底部或点击未读指示：恢复跟随并清零计数。 */
  | { type: 'reach-bottom' }
  /** 内容变化带来的新增行数；仅在智能暂停期间累计。 */
  | { type: 'append'; count: number }
  /** 手动开关切换或进入历史：无条件回到初始跟随状态。 */
  | { type: 'reset' }

export const initialLogFollowState: LogFollowState = { paused: false, pendingCount: 0 }

/**
 * 统计下一快照中上次没有的源记录；多重集合保留旧 API 的重复记录数量。
 */
export function countAppendedRows(
  previous: readonly LogEntry[],
  next: readonly LogEntry[],
): number {
  const remaining = new Map<string, number>()
  for (const record of previous) {
    const key = getLogIdentity(record)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  let appended = 0
  for (const record of next) {
    const key = getLogIdentity(record)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else appended += 1
  }
  return appended
}

export function reduceLogFollow(state: LogFollowState, action: LogFollowAction): LogFollowState {
  switch (action.type) {
    case 'leave-bottom':
      return state.paused ? state : { paused: true, pendingCount: 0 }
    case 'reach-bottom':
      return state.paused || state.pendingCount > 0 ? initialLogFollowState : state
    case 'append': {
      if (!state.paused || action.count <= 0) return state
      return { ...state, pendingCount: state.pendingCount + action.count }
    }
    case 'reset':
      return initialLogFollowState
  }
}
