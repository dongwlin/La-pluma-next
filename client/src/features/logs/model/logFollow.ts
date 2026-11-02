/**
 * 实时日志智能跟随状态机
 *
 * 手动「自动滚动」开关之外的第二层：开关打开时，用户离开滚动容器底部会
 * 临时暂停跟随并开始累计新增行数，回到底部或点击未读指示即恢复。手动
 * 开关关闭=永不跟随，此时组件不驱动本状态机；本模块不感知 DOM 与轮询，
 * 只裁决事件后的跟随状态。
 *
 * 计数语义：快照接口没有 cursor/offset，新增行数按相邻两次内容变化的行数
 * 差累计；等长轮转或收缩无法知道确切到达行数，按至少一条计。
 */

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
 * 两次内容变化之间到达的新增行数：行数差为正按差值计；行数未增长的内容
 * 变化（缓冲满轮转或整体收缩）按至少一条计。仅在指纹判定内容变化后调用。
 */
export function countAppendedRows(
  previous: readonly unknown[],
  next: readonly unknown[],
): number {
  const delta = next.length - previous.length
  return delta > 0 ? delta : 1
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
