import { useSyncExternalStore } from 'react'
import type { PanelStateStore } from '../model/panelState'

export function usePanelState<T>(store: PanelStateStore<T>): readonly [T, (next: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get)
  return [value, store.set]
}
