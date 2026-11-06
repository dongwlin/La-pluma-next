// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import type { RuntimeDiagnosticsReport } from '../api/diagnostics'
import RuntimeDiagnosticsPanel from './RuntimeDiagnosticsPanel'

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

function report(overrides: Partial<RuntimeDiagnosticsReport> = {}): RuntimeDiagnosticsReport {
  return {
    ok: false,
    status: 'warn',
    generatedAt: '2026-11-06T00:00:00.000Z',
    conclusion: '设备连接较慢，但可以继续执行',
    checks: [
      {
        id: 'runtime',
        title: '运行时',
        status: 'pass',
        summary: 'MAA 与 ADB 可用',
        details: ['CLI 版本 5.0.0', '内核版本 5.0.0'],
      },
      {
        id: 'connection',
        title: '设备连接',
        status: 'warn',
        summary: '连接耗时偏高',
        details: [],
        hint: '检查 ADB 路径与设备授权',
        locations: ['/opt/maa/config', 'adb devices'],
      },
      {
        id: 'execution',
        title: '执行链路',
        status: 'unknown',
        summary: '当前没有执行记录',
        details: [],
      },
    ],
    ...overrides,
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

let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

const renderPanel = async (command?: string) => {
  await act(async () => root.render(<RuntimeDiagnosticsPanel command={command} />))
  await flush()
}

const findButton = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find(button => button.textContent?.trim() === label)

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('[aria-label="辅助诊断"]')

describe('RuntimeDiagnosticsPanel', () => {
  beforeEach(() => {
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

  it('starts idle and only requests diagnostics on demand', async () => {
    await renderPanel('roguelike')

    expect(panel()?.textContent).toContain('辅助诊断')
    expect(panel()?.textContent).toContain('尚未运行诊断')
    expect(findButton('运行诊断')).toBeDefined()
    expect(apiMocks.fetchAgentDiagnostics).not.toHaveBeenCalled()
  })

  it('shows a loading action while the request is in flight', async () => {
    const request = deferred<ApiResponse<RuntimeDiagnosticsReport>>()
    apiMocks.fetchAgentDiagnostics.mockReturnValue(request.promise)
    await renderPanel('reclamation')

    await click(findButton('运行诊断')!)

    expect(panel()?.getAttribute('aria-busy')).toBe('true')
    expect(findButton('诊断中')?.disabled).toBe(true)
    expect(apiMocks.fetchAgentDiagnostics).toHaveBeenCalledWith({
      command: 'reclamation',
      signal: expect.any(AbortSignal),
    })

    await act(async () => request.resolve(ok(report())))
    await flush()

    expect(panel()?.getAttribute('aria-busy')).toBeNull()
    expect(findButton('运行诊断')?.disabled).toBe(false)
  })

  it('renders the conclusion, every check and its readable locations', async () => {
    apiMocks.fetchAgentDiagnostics.mockResolvedValue(ok(report()))
    await renderPanel('roguelike')

    await click(findButton('运行诊断')!)

    const text = panel()?.textContent ?? ''
    expect(text).toContain('设备连接较慢，但可以继续执行')
    expect(text).toContain('运行时')
    expect(text).toContain('MAA 与 ADB 可用')
    expect(text).toContain('CLI 版本 5.0.0')
    expect(text).toContain('通过')
    expect(text).toContain('连接耗时偏高')
    expect(text).toContain('注意')
    expect(text).toContain('建议：检查 ADB 路径与设备授权')
    expect(text).toContain('定位：/opt/maa/config、adb devices')
    expect(text).toContain('执行链路')
    expect(text).toContain('未知')
  })

  it('keeps the previous report and offers a retry when a later run fails', async () => {
    apiMocks.fetchAgentDiagnostics
      .mockResolvedValueOnce(ok(report()))
      .mockResolvedValueOnce(failed('诊断服务不可用'))
    await renderPanel()

    await click(findButton('运行诊断')!)
    await click(findButton('运行诊断')!)

    expect(panel()?.querySelector('[role="alert"]')?.textContent).toContain('诊断服务不可用')
    expect(panel()?.textContent).toContain('设备连接较慢，但可以继续执行')

    apiMocks.fetchAgentDiagnostics.mockResolvedValueOnce(ok(report({
      status: 'ok',
      conclusion: '运行环境正常',
    })))
    await click(findButton('重试')!)

    expect(panel()?.querySelector('[role="alert"]')).toBeNull()
    expect(panel()?.textContent).toContain('运行环境正常')
  })

  it('announces the conclusion through a live region', async () => {
    apiMocks.fetchAgentDiagnostics.mockResolvedValue(ok(report()))
    await renderPanel()

    await click(findButton('运行诊断')!)

    const liveRegion = panel()?.querySelector('[aria-live="polite"]')
    expect(liveRegion?.textContent).toContain('设备连接较慢，但可以继续执行')
  })
})
