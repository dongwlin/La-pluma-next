// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ITEM_ICON_CACHE_STORAGE_KEY } from './itemIconCache'

const loadStore = async () => {
  vi.resetModules()
  return import('./itemIconCache')
}

describe('item icon cache epoch', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('starts at zero and persists a monotonic epoch on invalidation', async () => {
    const store = await loadStore()
    expect(store.getItemIconCacheVersion()).toBe(0)

    const first = store.invalidateItemIconCache(1_700_000_000_000)
    expect(first).toBe(1_700_000_000_000)
    expect(localStorage.getItem(ITEM_ICON_CACHE_STORAGE_KEY)).toBe(String(first))

    // 同一时间戳也不能让 epoch 回退。
    const second = store.invalidateItemIconCache(1_700_000_000_000)
    expect(second).toBe(first + 1)
    expect(store.getItemIconCacheVersion()).toBe(second)
  })

  it('restores the persisted epoch after a browser reload', async () => {
    localStorage.setItem(ITEM_ICON_CACHE_STORAGE_KEY, '1700000000123')
    const store = await loadStore()
    expect(store.getItemIconCacheVersion()).toBe(1_700_000_000_123)
  })

  it('ignores a malformed or non-positive stored epoch', async () => {
    localStorage.setItem(ITEM_ICON_CACHE_STORAGE_KEY, 'not-a-number')
    expect((await loadStore()).getItemIconCacheVersion()).toBe(0)

    localStorage.setItem(ITEM_ICON_CACHE_STORAGE_KEY, '-5')
    expect((await loadStore()).getItemIconCacheVersion()).toBe(0)
  })

  it('notifies subscribers until they unsubscribe', async () => {
    const store = await loadStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribeItemIconCache(listener)

    store.invalidateItemIconCache(1_700_000_000_100)
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    store.invalidateItemIconCache(1_700_000_000_200)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps advancing the in-memory epoch when storage is unavailable', async () => {
    const store = await loadStore()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => store.invalidateItemIconCache(1_700_000_000_300)).not.toThrow()
    expect(store.getItemIconCacheVersion()).toBe(1_700_000_000_300)

    setItem.mockRestore()
  })
})
