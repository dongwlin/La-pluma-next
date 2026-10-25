// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCopilotInfo,
  getCopilotSet,
  getCopilotSetPlan,
  searchCopilot,
  searchParadoxCopilot,
} from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('combat resource reads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('forwards the search signal and validates the copilot list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { stage: '1-7', copilots: [{ id: 1, uri: 'prts://1' }], recommended: { id: 1 } },
    }))
    const controller = new AbortController()

    const result = await searchCopilot('1-7', controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/copilot/search?stage=1-7')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.copilots).toHaveLength(1)
  })

  it('turns a malformed search payload into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { stage: '1-7', copilots: 'not-an-array' },
    }))

    const result = await searchParadoxCopilot('阿米娅')

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '悖论模拟搜索结果格式不正确',
    })
  })

  it('keeps the PRTS proxy record accepted for copilot and set details', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { status_code: 200, data: { content: '{"stage_name":"1-7"}' } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { status_code: 200, data: { copilot_ids: [1, 2] } },
      }))
    const controller = new AbortController()

    const copilot = await getCopilotInfo('1', controller.signal)
    const set = await getCopilotSet('2')

    expect(fetchCall(0).init.signal).toBe(controller.signal)
    expect(copilot.success).toBe(true)
    expect(copilot.data?.status_code).toBe(200)
    expect(set.success).toBe(true)
    expect(set.data?.data?.copilot_ids).toEqual([1, 2])
  })

  it('validates the set plan shape and forwards its signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { setId: '2', name: '作业集', items: [{ id: 1 }], entries: [{ key: '0:1:normal' }] },
    }))
    const controller = new AbortController()

    const result = await getCopilotSetPlan('2', 'raid', controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/copilot-sets/2/plan?raid=raid')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
  })

  it('turns an incomplete set plan into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { setId: '2', items: [], entries: 'not-an-array' },
    }))

    const result = await getCopilotSetPlan('2')

    expect(result.success).toBe(false)
    expect(result.errorInfo?.code).toBe('INVALID_DOMAIN_PAYLOAD')
  })

  it('keeps the server search error code for old consumers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '未找到关卡"1-7"的作业',
      error: { code: 'AGENT_COPILOT_NOT_FOUND', retryable: false },
    }, 404))

    const result = await searchCopilot('1-7')

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'AGENT_COPILOT_NOT_FOUND',
      status: 404,
      kind: 'api',
    })
  })
})
