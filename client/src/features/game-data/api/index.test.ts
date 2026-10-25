// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAllOperators, getDepotData, getItemIconUrl, getOperBoxData } from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('game data resource reads', () => {
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

  it('forwards the signal and validates the owned operator snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { operCount: 1, data: [{ id: 'char_002_amiya' }], timestamp: '2026-10-25T00:00:00.000Z' },
    }))
    const controller = new AbortController()

    const result = await getOperBoxData(controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/data/operbox')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.operCount).toBe(1)
  })

  it('keeps the legacy empty operbox payload and rejects a malformed one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: true, data: null }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { operCount: 1, data: 'not-an-array' },
      }))

    const empty = await getOperBoxData()
    const malformed = await getOperBoxData()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(empty.success).toBe(true)
    expect(empty.data).toBeNull()
    expect(malformed.success).toBe(false)
    expect(malformed.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '干员识别结果格式不正确',
    })
  })

  it('forwards the signal when reading the full operator catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: [{ id: 'char_002_amiya' }],
    }))
    const controller = new AbortController()

    const result = await getAllOperators(controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/data/operators')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
  })

  it('rejects a catalog payload that is not an array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { operators: [] },
    }))

    const result = await getAllOperators()

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '全量干员列表格式不正确',
    })
  })

  it('aborts a shared resource read without issuing a stop or mutation request', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)
    const controller = new AbortController()

    const error = await getDepotData(controller.signal).catch(value => value)

    expect(error).toBe(abortError)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/data/depot')
    expect(fetchCall().init.method).toBeUndefined()
  })

  it('builds an encoded external item icon URL with the cache epoch without fetching it', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    expect(getItemIconUrl('30011', 0)).toBe(
      'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/refs/heads/main/item/30011.png?v=0',
    )
    expect(getItemIconUrl(4001, 7)).toContain('/item/4001.png?v=7')
    expect(getItemIconUrl('a b', 3)).toContain('/item/a%20b.png?v=3')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
