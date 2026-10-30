// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_TOKEN_STORAGE_KEY,
  clearAuthToken,
  fetchWithAuth,
  setAuthToken,
} from './client'

const authorizationOf = (callIndex: number) => {
  const headers = new Headers(vi.mocked(globalThis.fetch).mock.calls[callIndex]?.[1]?.headers)
  return headers.get('Authorization')
}

describe('fetchWithAuth connectivity errors', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    clearAuthToken()
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

describe('fetchWithAuth token cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    clearAuthToken()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('reads localStorage once and ignores direct writes until setAuthToken runs', async () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'seeded-token')

    await fetchWithAuth('/api/one')
    expect(authorizationOf(0)).toBe('Bearer seeded-token')

    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'ignored-token')
    await fetchWithAuth('/api/two')
    expect(authorizationOf(1)).toBe('Bearer seeded-token')

    setAuthToken('explicit-token')
    await fetchWithAuth('/api/three')
    expect(authorizationOf(2)).toBe('Bearer explicit-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('explicit-token')
  })

  it('refreshes the cache when another tab writes the token', async () => {
    setAuthToken('old-token')
    window.dispatchEvent(new StorageEvent('storage', {
      key: AUTH_TOKEN_STORAGE_KEY,
      newValue: 'cross-tab-token',
    }))

    await fetchWithAuth('/api/agent/status')

    expect(authorizationOf(0)).toBe('Bearer cross-tab-token')
  })

  it('clears the cached and stored token on logout', async () => {
    setAuthToken('Bearer session-token')
    clearAuthToken()

    await fetchWithAuth('/api/agent/status')

    expect(authorizationOf(0)).toBeNull()
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('does not send malformed stored tokens', async () => {
    setAuthToken('bad\u0000token')

    await fetchWithAuth('/api/agent/status')

    expect(authorizationOf(0)).toBeNull()
  })
})
