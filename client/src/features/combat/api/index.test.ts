// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  continueCopilotQueue,
  executeCopilotQueue,
  getCopilotInfo,
  getCopilotSet,
  getCopilotSetPlan,
  searchCopilot,
  searchParadoxCopilot,
  skipCopilotQueueEntry,
  uploadCopilotFile,
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

describe('copilot file uploads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  const file = (content = '{"stage_name":"1-7"}', name = 'job.json') => {
    const uploaded = new File([content], name, { type: 'application/json' })
    Object.defineProperty(uploaded, 'text', {
      configurable: true,
      value: () => Promise.resolve(content),
    })
    return uploaded
  }

  it('posts the file name and text content as JSON and returns the stored path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { path: '/data/copilot-files/job.json', name: 'job.json', bytes: 18 },
    }))

    const result = await uploadCopilotFile(file())

    expect(fetchCall().input).toBe('http://localhost:3000/api/copilot-files')
    expect(fetchCall().init.method).toBe('POST')
    expect(new Headers(fetchCall().init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(fetchCall().init.body))).toEqual({
      name: 'job.json',
      content: '{"stage_name":"1-7"}',
    })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      path: '/data/copilot-files/job.json',
      name: 'job.json',
    })
  })

  it.each([
    ['a missing path', { name: 'job.json' }],
    ['an empty path', { path: '' }],
    ['a blank path', { path: '   ' }],
  ])('rejects %s as an invalid domain payload', async (_label, data) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data }))

    const result = await uploadCopilotFile(file())

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '作业文件上传响应格式不正确',
    })
  })

  it('keeps the server failure code and message for the caller', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '作业文件不是合法 JSON',
      error: { code: 'COPILOT_FILE_INVALID', retryable: false },
    }, 400))

    const result = await uploadCopilotFile(file('not-json'))

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'COPILOT_FILE_INVALID',
      message: '作业文件不是合法 JSON',
      status: 400,
      kind: 'api',
    })
  })

  it('reports a readable error when the file cannot be read', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const unreadable = {
      name: 'broken.json',
      text: () => Promise.reject(new Error('读取失败')),
    } as unknown as File

    const result = await uploadCopilotFile(unreadable)

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'FILE_READ_FAILED',
      kind: 'transport',
      message: '读取失败',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('copilot queue runs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('posts the queue execute payload with its idempotency key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { runId: 'run-queue', accepted: true, waitingForNext: false },
    }))
    const payload = {
      queueId: 'copilot-queue',
      name: '我的作业队列',
      mode: 'manual' as const,
      failurePolicy: 'stop' as const,
      entries: [
        { clientId: 'queue-a', source: 'prts' as const, copilotId: 1088231, mode: 'normal' as const },
        { clientId: 'queue-b', source: 'file' as const, filename: '/data/copilot-imports/uuid.json' },
      ],
      options: { ignoreRequirements: true, loopTimes: 1 },
      waitForCompletion: false,
    }

    const result = await executeCopilotQueue(payload, { idempotencyKey: 'run_copilot_queue-key' })

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/copilot-queues/execute')
    expect(fetchCall().init.method).toBe('POST')
    expect(new Headers(fetchCall().init.headers).get('Idempotency-Key')).toBe('run_copilot_queue-key')
    expect(JSON.parse(String(fetchCall().init.body))).toEqual(payload)
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ runId: 'run-queue', accepted: true })
  })

  it('rejects a malformed queue execute response as a domain contract failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: {} }))

    const result = await executeCopilotQueue({
      entries: [{ clientId: 'queue-a', source: 'prts', copilotId: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      kind: 'contract',
      message: '作业队列执行响应格式不正确',
    })
  })

  it('keeps the server validation code and reason for a rejected queue', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '作业队列条目不合法',
      error: {
        code: 'AGENT_VALIDATION_ENTRIES',
        retryable: false,
        details: { reason: 'clientId 重复' },
      },
    }, 400))

    const result = await executeCopilotQueue({
      entries: [{ clientId: 'queue-a', source: 'prts', copilotId: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'AGENT_VALIDATION_ENTRIES',
      status: 400,
      kind: 'api',
      details: { reason: 'clientId 重复' },
    })
  })

  it('continues a waiting queue with the requested completion mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { runId: 'run-queue', accepted: true, waitingForNext: true },
    }))

    const result = await continueCopilotQueue('run-queue', false)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/actions/continue-copilot-queue')
    expect(fetchCall().init.method).toBe('POST')
    expect(JSON.parse(String(fetchCall().init.body))).toEqual({
      runId: 'run-queue',
      waitForCompletion: false,
    })
    expect(result.success).toBe(true)
  })

  it('keeps a busy execution code retryable for queue continues', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '设备正被占用',
      error: { code: 'MAA_EXECUTION_BUSY', retryable: true },
    }, 409))

    const result = await continueCopilotQueue('run-queue')

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'MAA_EXECUTION_BUSY',
      status: 409,
      retryable: true,
    })
  })

  it('skips the next queue entry by run id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { skippedClientId: 'queue-a', waitingForNext: true, finished: false },
    }))

    const result = await skipCopilotQueueEntry('run-queue')

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/actions/skip-copilot-queue-entry')
    expect(fetchCall().init.method).toBe('POST')
    expect(JSON.parse(String(fetchCall().init.body))).toEqual({ runId: 'run-queue' })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ skippedClientId: 'queue-a', waitingForNext: true })
  })

  it('rejects a skip response without the skipped entry identity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { waitingForNext: true },
    }))

    const result = await skipCopilotQueueEntry('run-queue')

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '跳过作业队列项响应格式不正确',
    })
  })
})
