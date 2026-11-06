// @vitest-environment jsdom

import { Activity, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import type { RuntimeDiagnosticsReport } from '../api/diagnostics'
import { useRuntimeDiagnostics, type RuntimeDiagnosticsState } from './useRuntimeDiagnostics'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  fetchAgentDiagnostics: vi.fn(),
}))

vi.mock('../api/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/diagnostics')>()
  return { ...actual, fetchAgentDiagnostics: apiMocks.fetchAgentDiagnostics }
})

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data })
const failed = (message: string): ApiResponse => ({
  success: false,
  error: message,
  message,
  errorInfo: { code: 'HTTP_500', message },
})

function report(conclusion: string): RuntimeDiagnosticsReport {
  return {
    ok: true,
    status: 'ok',
    generatedAt: '2026-11-06T00:00:00.000Z',
    conclusion,
    checks: [{
      id: 'runtime',
      title: '运行时',
      status: 'pass',
      summary: '可用',
      details: [],
    }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

let latest: RuntimeDiagnosticsState | null = null

function Harness({ command }: { command?: string }) {
  const state = useRuntimeDiagnostics(command)
  useEffect(() => {
    latest = state
  })
  return (
    <button type="button" onClick={state.start}>
      运行诊断
    </button>
  )
}

let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

const renderHarness = async (mode: 'visible' | 'hidden' = 'visible', command?: string) => {
  await act(async () => {
    root.render(
      <Activity mode={mode}>
        <Harness command={command} />
      </Activity>,
    )
  })
  await flush()
}

const clickStart = async () => {
  const button = container.querySelector('button')
  if (!button) throw new Error('start button is missing')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

describe('useRuntimeDiagnostics', () => {
  beforeEach(() => {
    latest = null
    apiMocks.fetchAgentDiagnostics.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('stays idle until the first explicit start', async () => {
    await renderHarness()

    expect(latest?.status).toBe('idle')
    expect(latest?.report).toBeNull()
    expect(apiMocks.fetchAgentDiagnostics).not.toHaveBeenCalled()
  })

  it('loads one report for one start and passes the command through', async () => {
    const request = deferred<ApiResponse<RuntimeDiagnosticsReport>>()
    apiMocks.fetchAgentDiagnostics.mockReturnValue(request.promise)
    await renderHarness('visible', 'roguelike')

    await clickStart()

    expect(latest?.status).toBe('loading')
    expect(apiMocks.fetchAgentDiagnostics).toHaveBeenCalledOnce()
    expect(apiMocks.fetchAgentDiagnostics).toHaveBeenCalledWith({
      command: 'roguelike',
      signal: expect.any(AbortSignal),
    })

    await act(async () => request.resolve(ok(report('环境正常'))))
    await flush()

    expect(latest?.status).toBe('ready')
    expect(latest?.error).toBeNull()
    expect(latest?.report?.conclusion).toBe('环境正常')
  })

  it('keeps a single request in flight when start is triggered repeatedly', async () => {
    const request = deferred<ApiResponse<RuntimeDiagnosticsReport>>()
    apiMocks.fetchAgentDiagnostics.mockReturnValue(request.promise)
    await renderHarness()

    await clickStart()
    await clickStart()
    await clickStart()

    expect(apiMocks.fetchAgentDiagnostics).toHaveBeenCalledOnce()

    await act(async () => request.resolve(ok(report('环境正常'))))
    await flush()

    expect(latest?.status).toBe('ready')
  })

  it('keeps the previous report and its error message when a retry fails', async () => {
    apiMocks.fetchAgentDiagnostics
      .mockResolvedValueOnce(ok(report('环境正常')))
      .mockResolvedValueOnce(failed('诊断服务不可用'))
    await renderHarness()

    await clickStart()
    await clickStart()

    expect(latest?.status).toBe('error')
    expect(latest?.error).toBe('诊断服务不可用')
    expect(latest?.report?.conclusion).toBe('环境正常')
  })

  it('does not present a cancelled request as an error', async () => {
    const request = deferred<ApiResponse<RuntimeDiagnosticsReport>>()
    apiMocks.fetchAgentDiagnostics.mockReturnValue(request.promise)
    await renderHarness()

    await clickStart()
    await renderHarness('hidden')
    await renderHarness('visible')

    expect(latest?.status).toBe('idle')
    expect(latest?.error).toBeNull()

    await act(async () => request.reject(new DOMException('请求已取消', 'AbortError')))
    await flush()

    expect(latest?.status).toBe('idle')
    expect(latest?.error).toBeNull()
  })

  it('aborts the in-flight request when the panel is hidden and allows a new start after restore', async () => {
    const first = deferred<ApiResponse<RuntimeDiagnosticsReport>>()
    apiMocks.fetchAgentDiagnostics.mockReturnValueOnce(first.promise)
    await renderHarness()

    await clickStart()
    const firstSignal = apiMocks.fetchAgentDiagnostics.mock.calls[0]![0].signal as AbortSignal
    expect(firstSignal.aborted).toBe(false)

    await renderHarness('hidden')
    expect(firstSignal.aborted).toBe(true)

    await act(async () => first.reject(new DOMException('请求已取消', 'AbortError')))
    await renderHarness('visible')

    apiMocks.fetchAgentDiagnostics.mockResolvedValueOnce(ok(report('环境正常')))
    await clickStart()

    expect(apiMocks.fetchAgentDiagnostics).toHaveBeenCalledTimes(2)
    expect(latest?.status).toBe('ready')
  })

  it('clears the retained report only when reset is called', async () => {
    apiMocks.fetchAgentDiagnostics.mockResolvedValueOnce(ok(report('环境正常')))
    await renderHarness()

    await clickStart()
    await act(async () => latest?.reset())
    await flush()

    expect(latest?.status).toBe('idle')
    expect(latest?.report).toBeNull()
    expect(latest?.error).toBeNull()
  })
})
