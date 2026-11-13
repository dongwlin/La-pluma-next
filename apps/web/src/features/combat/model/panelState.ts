// 搜索词、识别方式等面板局部状态在面板卸载后仍需保留，但不进入配置协调器或
// Query；工作区创建会话存储，面板只订阅自己的字段，输入变化不推动作业集列表重渲染。

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
