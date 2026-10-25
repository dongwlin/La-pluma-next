// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDepotData, getDropStatistics, getOpenTodayStages } from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('statistics resource reads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('forwards the abort signal and returns validated depot data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { itemCount: 1, items: [{ id: '30011', count: 4 }], timestamp: '2026-10-25T00:00:00.000Z' },
    }))
    const controller = new AbortController()

    const result = await getDepotData(controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/data/depot')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ itemCount: 1, items: [{ id: '30011', count: 4 }], timestamp: '2026-10-25T00:00:00.000Z' })
  })

  it('keeps the legacy empty depot payload as a successful null data value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: null }))

    const result = await getDepotData()

    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
  })

  it('turns a malformed depot payload into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { itemCount: 1, items: 'not-an-array' },
    }))

    const result = await getDepotData()

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '仓库数据格式不正确',
      retryable: false,
    })
  })

  it('keeps a server success=false envelope as a typed failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '读取掉落统计失败',
      error: { code: 'AGENT_DROPS_READ_FAILED', retryable: true },
    }, 503))
    const controller = new AbortController()

    const result = await getDropStatistics(30, controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/drops/statistics?days=30')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'AGENT_DROPS_READ_FAILED',
      kind: 'api',
      status: 503,
      retryable: true,
    })
  })

  it('rejects a service error envelope that the route wrapped as success data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { success: false, message: '获取掉落统计失败' },
    }))

    const result = await getDropStatistics(7)

    expect(result.success).toBe(false)
    expect(result.errorInfo?.code).toBe('INVALID_DOMAIN_PAYLOAD')
  })

  it('validates open today stages and keeps open/closed arrays', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { weekday: 1, open: [{ stage: 'CE-6' }], closed: [] },
    }))

    const result = await getOpenTodayStages()

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ weekday: 1, open: [{ stage: 'CE-6' }], closed: [] })
  })

  it('aborts a depot read without issuing a stop or mutation request', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)
    const controller = new AbortController()

    const error = await getDepotData(controller.signal).catch(value => value)

    expect(error).toBe(abortError)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/data/depot')
    expect(fetchCall().init.method).toBeUndefined()
  })
})
