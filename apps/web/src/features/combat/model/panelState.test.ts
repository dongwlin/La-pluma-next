import { describe, expect, it, vi } from 'vitest'
import { createPanelStateStore } from './panelState'

describe('createPanelStateStore', () => {
  it('returns the latest value and notifies subscribers only on change', () => {
    const store = createPanelStateStore('auto')
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    expect(store.get()).toBe('auto')

    store.set('single')
    expect(store.get()).toBe('single')
    expect(listener).toHaveBeenCalledTimes(1)

    // 相同值不产生通知，避免受控输入重复渲染。
    store.set('single')
    expect(listener).toHaveBeenCalledTimes(1)

    store.set('set')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.set('auto')
    expect(store.get()).toBe('auto')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('notifies every current subscriber and tolerates unsubscribe during notification', () => {
    const store = createPanelStateStore(0)
    const calls: number[] = []
    const unsubscribeFirst = store.subscribe(() => {
      calls.push(1)
      unsubscribeFirst()
    })
    store.subscribe(() => calls.push(2))

    store.set(1)

    expect(calls).toEqual([1, 2])
    store.set(2)
    expect(calls).toEqual([1, 2, 2])
  })

  it('keeps independent stores isolated', () => {
    const stage = createPanelStateStore('')
    const selection = createPanelStateStore('')
    const stageListener = vi.fn()

    stage.subscribe(stageListener)
    selection.set('prts://1')

    expect(stage.get()).toBe('')
    expect(selection.get()).toBe('prts://1')
    expect(stageListener).not.toHaveBeenCalled()
  })
})
