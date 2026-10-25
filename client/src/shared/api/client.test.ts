// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithAuth } from './client'

describe('fetchWithAuth connectivity errors', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('distinguishes browser offline state from an unavailable backend', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(fetchWithAuth('/api/agent/status')).rejects.toThrow('当前网络已断开，请恢复连接后重试')
  })

  it('keeps the backend guidance when the browser itself is online', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(fetchWithAuth('/api/agent/status')).rejects.toThrow('无法连接后端服务，请确认服务已启动')
  })

  it('rethrows DOMException aborts without rewriting them as connectivity errors', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

    await expect(fetchWithAuth('/api/agent/status')).rejects.toBe(abortError)
  })
})
