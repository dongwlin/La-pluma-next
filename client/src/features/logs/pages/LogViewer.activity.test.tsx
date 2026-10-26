// @vitest-environment jsdom

import { Activity, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import LogViewer from './LogViewer'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getRealtimeLogs: vi.fn(),
  getLogFiles: vi.fn(),
  readLogFile: vi.fn(),
  clearRealtimeLogs: vi.fn(),
  cleanupLogs: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const MotionDiv = React.forwardRef<HTMLDivElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children as ReactNode),
  )
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: MotionDiv },
    useReducedMotion: () => true,
  }
})

vi.mock('../api', () => mocks)

vi.mock('@/features/runtime-status', () => ({ FloatingStatusIndicator: () => null }))

const row = (message: string) => ({
  time: '2026-07-22T10:11:12',
  level: 'INFO',
  message,
})

const historyFile = {
  name: 'maa.log',
  path: '/logs/maa.log',
  modified: '2026-07-22T10:00:00.000Z',
  size: 1024,
}

const historyLine = (message: string) => `[2026-07-22 10:11:12][INFO] ${message}`

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root
let visibility: DocumentVisibilityState

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const renderMode = async (mode: 'visible' | 'hidden') => {
  await act(async () => root.render(
    <Activity mode={mode}>
      <LogViewer />
    </Activity>,
  ))
  await flush()
}

const setVisibility = async (state: DocumentVisibilityState) => {
  visibility = state
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await flush()
}

describe('LogViewer realtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    mocks.getRealtimeLogs.mockReset().mockResolvedValue({ success: true, data: [] })
    mocks.getLogFiles.mockReset().mockResolvedValue({ success: true, data: [] })
    mocks.readLogFile.mockReset()
    mocks.clearRealtimeLogs.mockReset()
    mocks.cleanupLogs.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stops polling and aborts the in-flight read when Activity hides, then refreshes on restore', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({ success: true, data: [row('隐藏前')] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ success: true, data: [row('恢复后')] })

    await renderMode('visible')
    expect(container.textContent).toContain('隐藏前')

    await advance(1250)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    const hiddenSignal = mocks.getRealtimeLogs.mock.calls[1]?.[1] as AbortSignal | undefined
    expect(hiddenSignal?.aborted).toBe(false)

    await renderMode('hidden')
    expect(hiddenSignal?.aborted).toBe(true)

    await advance(5000)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)

    await renderMode('visible')
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('恢复后')
    expect(container.textContent).not.toContain('隐藏前')
  })

  it('does not send requests while the document is hidden and reads immediately when visible', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({ success: true, data: [row('文档可见')] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ success: true, data: [row('文档恢复')] })

    await renderMode('visible')
    expect(container.textContent).toContain('文档可见')

    await advance(1250)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    const hiddenSignal = mocks.getRealtimeLogs.mock.calls[1]?.[1] as AbortSignal | undefined
    expect(hiddenSignal?.aborted).toBe(false)

    await setVisibility('hidden')
    expect(hiddenSignal?.aborted).toBe(true)
    await advance(5000)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)

    await setVisibility('visible')
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('文档恢复')
    expect(container.textContent).not.toContain('文档可见')
  })

  it('does not stack polls while a realtime read is slow', async () => {
    const slow = deferred<ApiResponse<unknown>>()
    mocks.getRealtimeLogs
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue({ success: true, data: [row('下一次')] })

    await renderMode('visible')
    await advance(1250 * 4)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)

    slow.resolve({ success: true, data: [row('慢请求返回')] })
    await flush()
    expect(container.textContent).toContain('慢请求返回')

    await advance(1250)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('下一次')
  })

  it('pauses polling while clearing and resumes with an immediate read', async () => {
    const clearing = deferred<ApiResponse<unknown>>()
    const resumed = deferred<ApiResponse<unknown>>()
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({ success: true, data: [row('清空前')] })
      .mockReturnValueOnce(resumed.promise)
    mocks.clearRealtimeLogs.mockReturnValueOnce(clearing.promise)

    await renderMode('visible')
    expect(container.textContent).toContain('清空前')

    const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清空')
    await act(async () => clearButton?.click())
    await flush()

    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清空')
    expect(confirmButton).toBeTruthy()
    await act(async () => confirmButton?.click())
    await flush()

    const busyClearButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清空')
    expect(busyClearButton?.disabled).toBe(true)

    await advance(5000)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)

    clearing.resolve({ success: true, message: '实时日志已清空' })
    await flush()
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('实时日志已清空')
    expect(container.textContent).not.toContain('清空前')
    expect(busyClearButton?.disabled).toBe(false)

    resumed.resolve({ success: true, data: [] })
    await flush()
  })

  it('retries an in-flight history read on restore without leaving loading', async () => {
    const beforeHide = deferred<ApiResponse<unknown>>()
    const afterRestore = deferred<ApiResponse<unknown>>()
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [historyFile] })
    mocks.readLogFile
      .mockReturnValueOnce(beforeHide.promise)
      .mockReturnValueOnce(afterRestore.promise)

    await renderMode('visible')
    const historyRow = container.querySelector<HTMLButtonElement>('.log-history-row')
    await act(async () => historyRow?.click())
    await flush()
    expect(mocks.readLogFile).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    const hiddenSignal = mocks.readLogFile.mock.calls[0]?.[2] as AbortSignal | undefined

    await renderMode('hidden')
    expect(hiddenSignal?.aborted).toBe(true)

    beforeHide.resolve({ success: true, data: { content: historyLine('隐藏期间返回') } })
    await flush()
    expect(container.textContent).not.toContain('隐藏期间返回')

    await renderMode('visible')
    expect(mocks.readLogFile).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.textContent).not.toContain('隐藏期间返回')

    afterRestore.resolve({ success: true, data: { content: historyLine('恢复后读取') } })
    await flush()
    expect(container.textContent).toContain('恢复后读取')
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('keeps history mode on restore without restarting realtime polling', async () => {
    mocks.getRealtimeLogs.mockResolvedValue({ success: true, data: [row('实时行')] })
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [historyFile] })
    mocks.readLogFile.mockResolvedValue({
      success: true,
      data: { content: historyLine('历史内容') },
    })

    await renderMode('visible')
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)
    const historyRow = container.querySelector<HTMLButtonElement>('.log-history-row')
    await act(async () => historyRow?.click())
    await flush()
    expect(container.textContent).toContain('历史内容')

    await advance(5000)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)

    await renderMode('hidden')
    await renderMode('visible')
    await flush()
    expect(mocks.getLogFiles).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('历史内容')

    await advance(5000)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)
  })

  it('keeps the open history file when the restored file list fails and retries the list', async () => {
    mocks.getLogFiles
      .mockResolvedValueOnce({ success: true, data: [historyFile] })
      .mockResolvedValueOnce({ success: false, message: '列表刷新失败' })
      .mockResolvedValueOnce({ success: true, data: [historyFile] })
    mocks.readLogFile.mockResolvedValue({
      success: true,
      data: { content: historyLine('历史内容') },
    })

    await renderMode('visible')
    const historyRow = container.querySelector<HTMLButtonElement>('.log-history-row')
    await act(async () => historyRow?.click())
    await flush()
    expect(container.textContent).toContain('历史内容')

    await renderMode('hidden')
    await renderMode('visible')
    await flush()

    expect(container.textContent).toContain('历史内容')
    const listError = container.querySelector<HTMLElement>('.log-history-state.is-error')
    expect(listError?.textContent).toContain('列表刷新失败')
    expect(mocks.readLogFile).toHaveBeenCalledTimes(1)

    await act(async () => listError?.querySelector<HTMLButtonElement>('button')?.click())
    await flush()
    expect(container.querySelector('.log-history-state.is-error')).toBeNull()
    expect(container.textContent).toContain('历史内容')
  })

  it('aborts the local clear wait when the page unmounts', async () => {
    const clearing = deferred<ApiResponse<unknown>>()
    mocks.getRealtimeLogs.mockResolvedValue({ success: true, data: [row('清空前')] })
    mocks.clearRealtimeLogs.mockReturnValueOnce(clearing.promise)

    await renderMode('visible')
    const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清空')
    await act(async () => clearButton?.click())
    await flush()
    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清空')
    await act(async () => confirmButton?.click())
    await flush()

    const signal = mocks.clearRealtimeLogs.mock.calls[0]?.[0] as AbortSignal | undefined
    expect(signal?.aborted).toBe(false)

    await act(async () => root.unmount())
    expect(signal?.aborted).toBe(true)

    clearing.resolve({ success: true, message: '实时日志已清空' })
    await flush()
  })
})
