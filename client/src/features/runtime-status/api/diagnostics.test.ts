// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeDiagnosticsReport } from './diagnostics'
import { INVALID_DIAGNOSTICS_PAYLOAD_MESSAGE, fetchAgentDiagnostics } from './diagnostics'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

function report(overrides: Partial<RuntimeDiagnosticsReport> = {}): RuntimeDiagnosticsReport {
  return {
    ok: true,
    status: 'ok',
    generatedAt: '2026-11-06T00:00:00.000Z',
    conclusion: '运行环境正常',
    checks: [
      {
        id: 'runtime',
        title: '运行时',
        status: 'pass',
        summary: 'MAA 与 ADB 可用',
        details: ['CLI 版本 5.0.0'],
      },
      {
        id: 'connection',
        title: '设备连接',
        status: 'warn',
        summary: '连接较慢',
        details: [],
        hint: '检查 ADB 路径',
        locations: ['/opt/maa/config'],
      },
    ],
    ...overrides,
  }
}

describe('fetchAgentDiagnostics', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('requests the bare endpoint when no command is selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: report() }))
    const controller = new AbortController()

    const result = await fetchAgentDiagnostics({ signal: controller.signal })

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/diagnostics')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.conclusion).toBe('运行环境正常')
  })

  it('passes the selected command as an encoded query parameter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: report() }))

    await fetchAgentDiagnostics({ command: ' roguelike ' })

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/diagnostics?command=roguelike')
  })

  it('keeps optional hint and locations when the payload is valid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: report() }))

    const result = await fetchAgentDiagnostics()

    expect(result.success).toBe(true)
    expect(result.data?.checks[1]).toMatchObject({
      id: 'connection',
      status: 'warn',
      hint: '检查 ADB 路径',
      locations: ['/opt/maa/config'],
    })
  })

  it('rejects a payload whose checks are not typed objects', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { ...report(), checks: [{ id: 'runtime', title: '运行时', status: 'bad' }] },
    }))

    const result = await fetchAgentDiagnostics()

    expect(result.success).toBe(false)
    expect(result.message).toBe(INVALID_DIAGNOSTICS_PAYLOAD_MESSAGE)
    expect(result.errorInfo?.code).toBe('INVALID_DOMAIN_PAYLOAD')
  })

  it('rejects a payload without a checks array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { ok: true, status: 'ok', generatedAt: 'now', conclusion: 'fine' },
    }))

    const result = await fetchAgentDiagnostics()

    expect(result.success).toBe(false)
    expect(result.message).toBe(INVALID_DIAGNOSTICS_PAYLOAD_MESSAGE)
  })

  it('keeps cancellation as an AbortError instead of a failure envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(
      new DOMException('请求已取消', 'AbortError'),
    ))
    const controller = new AbortController()
    controller.abort()

    await expect(fetchAgentDiagnostics({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
