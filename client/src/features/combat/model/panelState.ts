/**
 * 面板局部状态的会话存储
 *
 * 作业页的搜索词、识别方式与搜索选中项属于最近的面板，不需要进入配置
 * 协调器或 Query。它们又需要在作业类型切换（面板卸载）后保留，因此由
 * 工作区创建一份会话存储，面板通过 `usePanelState` 订阅自己关心的字段。
 *
 * 工作区不订阅这些值：输入变化只通知订阅它的面板，不推动作业集列表等
 * 无关区域重渲染；真正卸载页面时存储随工作区一起销毁。
 */

export interface PanelStateStore<T> {
  readonly get: () => T
  readonly set: (next: T) => void
  readonly subscribe: (listener: () => void) => () => void
}

export function createPanelStateStore<T>(initial: T): PanelStateStore<T> {
  let value = initial
  const listeners = new Set<() => void>()

  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
