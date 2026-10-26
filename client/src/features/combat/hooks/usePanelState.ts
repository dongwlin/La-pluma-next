/**
 * 面板会话状态的 React 适配
 *
 * 面板只订阅自己关心的字段；工作区创建存储但不订阅，因此输入变化不会
 * 推动作业集列表等无关面板重渲染。`getServerSnapshot` 复用当前值，
 * 本应用没有服务端渲染分支。
 */

import { useSyncExternalStore } from 'react'
import type { PanelStateStore } from '../model/panelState'

export function usePanelState<T>(store: PanelStateStore<T>): readonly [T, (next: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get)
  return [value, store.set]
}
