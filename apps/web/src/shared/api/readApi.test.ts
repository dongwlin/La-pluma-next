// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  isAbortError,
  readApiData,
  readApiResponse,
  unwrapApiResponse,
} from './readApi'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const isItemsPayload = (payload: unknown): boolean =>
  Boolean(payload)
  && typeof payload === 'object'
  && Array.isArray((payload as { items?: unknown }).items)

describe('readApiData', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('forwards the abort signal to fetch and returns validated data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { items: [{ id: '1' }] },
      message: '操作成功',
    }))
    const controller = new AbortController()

    const result = await readApiData('/api/agent/data/depot', {
      signal: controller.signal,
      validate: isItemsPayload,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/data/depot', expect.objectContaining({
      signal: controller.signal,
    }))
    expect(result.data).toEqual({ items: [{ id: '1' }] })
    expect(result.message).toBe('操作成功')
  })

  it('turns success=false into a typed api failure without exposing it as data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: 'MAA 正在执行其他任务',
      error: { code: 'AGENT_EXECUTION_BUSY', retryable: true, details: { owner: '仓库识别' } },
    }, 409))

    await expect(readApiData('/api/agent/activity')).rejects.toMatchObject({
      name: 'ApiRequestError',
      kind: 'api',
      code: 'AGENT_EXECUTION_BUSY',
      message: 'MAA 正在执行其他任务',
      status: 409,
      retryable: true,
      details: { owner: '仓库识别' },
    })
  })

  it('treats a 2xx success=false envelope as a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '数据尚未生成',
      error: { code: 'AGENT_DATA_NOT_READY', retryable: false },
    }))

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'api',
      code: 'AGENT_DATA_NOT_READY',
      status: 200,
      retryable: false,
    })
  })

  it('turns a malformed domain payload into an explicit contract failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { items: 'not-an-array' },
    }))

    const error = await readApiData('/api/agent/data/depot', {
      validate: isItemsPayload,
      invalidPayloadMessage: '仓库数据格式不正确',
    }).catch(value => value)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      kind: 'contract',
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '仓库数据格式不正确',
      retryable: false,
    })
  })

  it('turns a non-envelope JSON body into a contract failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status_code: 200, data: {} }))

    await expect(readApiData('/api/agent/copilots/1')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_API_RESPONSE',
    })
  })

  it('turns an empty 2xx body into a contract failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'contract',
      code: 'EMPTY_API_RESPONSE',
    })
  })

  it('turns malformed JSON on a 2xx response into a contract failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>ok</html>', { status: 200 }))

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'contract',
      code: 'INVALID_API_RESPONSE',
    })
  })

  it('does not accept a success envelope that arrived with a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: { items: [] } }, 500))

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'api',
      code: 'HTTP_500',
      status: 500,
      retryable: true,
    })
  })

  it('describes a malformed error body with the HTTP status instead of a parser error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'api',
      code: 'HTTP_502',
      status: 502,
    })
  })

  it('keeps an aborted read as AbortError instead of a failure result', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)
    const controller = new AbortController()

    await expect(readApiData('/api/agent/data/depot', { signal: controller.signal })).rejects.toBe(abortError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/agent/data/depot')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBeUndefined()
  })

  it('rejects an in-flight read when the caller aborts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }))
    const controller = new AbortController()

    const pending = readApiData('/api/agent/data/depot', { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not call fetch when the signal is already aborted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    controller.abort()

    const error = await readApiData('/api/agent/data/depot', { signal: controller.signal }).catch(value => value)
    expect(isAbortError(error)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies a network failure as transport', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)

    await expect(readApiData('/api/agent/data/depot')).rejects.toMatchObject({
      kind: 'transport',
      code: 'NETWORK_ERROR',
      retryable: true,
    })
  })
})

describe('readApiResponse legacy compatibility', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns the existing success envelope shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { items: [] },
      message: '操作成功',
      meta: { requestId: 'request-1' },
    }))

    const result = await readApiResponse('/api/agent/data/depot')

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ items: [] })
    expect(result.message).toBe('操作成功')
    expect(result.meta?.requestId).toBe('request-1')
  })

  it('returns a failure envelope with typed errorInfo for old consumers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: false,
      message: '未找到作业',
      error: { code: 'AGENT_COPILOT_NOT_FOUND', retryable: false },
    }, 404))

    const result = await readApiResponse('/api/agent/copilot/search?stage=1-7')

    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.message).toBe('未找到作业')
    expect(result.errorInfo).toMatchObject({
      code: 'AGENT_COPILOT_NOT_FOUND',
      message: '未找到作业',
      kind: 'api',
      status: 404,
      retryable: false,
    })
  })

  it('keeps cancellation as AbortError for old consumers that only check signal.aborted', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)
    const controller = new AbortController()

    await expect(readApiResponse('/api/agent/logs/recent', { signal: controller.signal })).rejects.toBe(abortError)
  })
})

describe('unwrapApiResponse', () => {
  it('returns data for a legacy success envelope', () => {
    expect(unwrapApiResponse({ success: true, data: { items: [] } })).toEqual({ items: [] })
  })

  it('restores a typed error from a legacy failure envelope', () => {
    expect(() => unwrapApiResponse({
      success: false,
      message: '服务返回了无法识别的数据',
      errorInfo: {
        code: 'INVALID_DOMAIN_PAYLOAD',
        message: '服务返回了无法识别的数据',
        kind: 'contract',
        retryable: false,
      },
    })).toThrow(ApiRequestError)
  })
})
