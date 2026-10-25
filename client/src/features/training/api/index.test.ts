// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAllOperators, getOperatorList, getTrainingQueue } from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('training resource reads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('keeps the legacy filter call and forwards the abort signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { operators: [{ id: 'char_002_amiya' }], count: 1 },
    }))
    const controller = new AbortController()

    const result = await getOperatorList({ status: 'trainable', needsElite2: true }, controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/training/operators?needsElite2=true&status=trainable')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ operators: [{ id: 'char_002_amiya' }], count: 1 })
  })

  it('accepts the legacy array operator payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: [{ id: 'char_002_amiya' }],
    }))

    const result = await getOperatorList({ status: 'all' })

    expect(result.success).toBe(true)
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

  it('turns a malformed queue payload into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { queue: 'not-an-array', revision: 'r1' },
    }))
    const controller = new AbortController()

    const result = await getTrainingQueue(controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/training/queue')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '养成队列数据格式不正确',
    })
  })

  it('keeps a successful queue with revision and flow sync intact', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { queue: [{ operatorId: 'char_002_amiya' }], revision: 'r1', flowSync: { status: 'synced' } },
    }))

    const result = await getTrainingQueue()

    expect(result.success).toBe(true)
    expect(result.data?.queue).toHaveLength(1)
    expect(result.data?.revision).toBe('r1')
  })
})
