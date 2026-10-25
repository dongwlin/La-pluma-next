// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLogFiles, getRealtimeLogs, readLogFile } from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('logs resource reads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('passes the realtime polling signal to fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: [{ time: '2026-10-25T00:00:00.000Z', level: 'INFO', message: 'ok' }],
    }))
    const controller = new AbortController()

    const result = await getRealtimeLogs(200, controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/logs/recent?lines=200')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
  })

  it('turns a non-array realtime payload into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: { lines: [] } }))

    const result = await getRealtimeLogs(200)

    expect(result.success).toBe(false)
    expect(result.errorInfo?.code).toBe('INVALID_DOMAIN_PAYLOAD')
  })

  it('forwards the signal when listing files and reading a file', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ path: '/tmp/a.log', name: 'a.log' }] }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { content: 'line-1\nline-2', totalLines: 2, returnedLines: 2 },
      }))
    const filesController = new AbortController()
    const readController = new AbortController()

    const files = await getLogFiles(filesController.signal)
    const content = await readLogFile('/tmp/a.log', 1000, readController.signal)

    expect(fetchCall(0).input).toBe('http://localhost:3000/api/agent/logs/files')
    expect(fetchCall(0).init.signal).toBe(filesController.signal)
    expect(files.success).toBe(true)
    expect(fetchCall(1).input).toBe('http://localhost:3000/api/agent/logs/files/%2Ftmp%2Fa.log?lines=1000')
    expect(fetchCall(1).init.signal).toBe(readController.signal)
    expect(content.success).toBe(true)
    expect(content.data?.content).toBe('line-1\nline-2')
  })

  it('turns malformed file content into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { content: 42, totalLines: 1, returnedLines: 1 },
    }))

    const result = await readLogFile('/tmp/a.log', 1000)

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '日志文件内容格式不正确',
    })
  })

  it('keeps a cancelled background poll as AbortError', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)
    const controller = new AbortController()

    const error = await getRealtimeLogs(200, controller.signal).catch(value => value)

    expect(error).toBe(abortError)
    expect(fetchCall().init.method).toBeUndefined()
  })
})
