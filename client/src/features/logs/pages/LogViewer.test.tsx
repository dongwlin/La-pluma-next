// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
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

let container: HTMLDivElement
let root: Root
let visibility: DocumentVisibilityState

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const historyFile = (name: string, path = `/logs/${name}`) => ({
  name,
  path,
  modified: '2026-07-22T10:00:00.000Z',
  size: 1024,
})

const historyLine = (message: string) => `[2026-07-22 10:11:12][INFO] ${message}`

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const renderComponent = async () => {
  await act(async () => root.render(<LogViewer />))
  await flush()
}

const click = async (element: HTMLElement) => {
  await act(async () => element.click())
  await flush()
}

const changeSelect = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

describe('LogViewer recovery and controls', () => {
  beforeEach(() => {
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
    mocks.getRealtimeLogs.mockReset().mockResolvedValue({ success: true, data: [] })
    mocks.getLogFiles.mockReset().mockResolvedValue({ success: true, data: [] })
    mocks.readLogFile.mockReset()
    mocks.clearRealtimeLogs.mockReset()
    mocks.cleanupLogs.mockReset()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows a retry action when realtime logs fail and replaces the error after recovery', async () => {
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({ success: false, message: '实时日志暂不可用' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ time: '2026-07-22T10:11:12.000Z', level: 'INFO', message: 'TaskChainStart' }],
      })

    await renderComponent()

    expect(container.querySelector('h1')?.textContent).toBe('日志')
    const error = container.querySelector<HTMLElement>('.log-console-state.is-error')
    expect(error?.textContent).toContain('实时日志暂不可用')
    expect(container.textContent).not.toContain('暂无实时日志，等待任务执行')
    const realtimeRetry = error?.querySelector<HTMLButtonElement>('button')
    expect(realtimeRetry).not.toBeNull()
    await click(realtimeRetry!)

    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.log-console-state.is-error')).toBeNull()
    expect(container.textContent).toContain('TaskChainStart')
    expect(container.querySelector('.log-mode-shell.app-liquid-tab-pill')).not.toBeNull()
    expect(container.querySelector('.log-toolbar .log-mode-shell')).toBeNull()
    const modeTabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.log-mode-shell [role="tab"]'))
    expect(modeTabs).toHaveLength(2)
    expect(modeTabs[0]?.getAttribute('aria-selected')).toBe('true')
    await click(modeTabs[1]!)
    expect(modeTabs[1]?.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      modeTabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    await flush()
    expect(modeTabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(modeTabs[0])

    const switches = Array.from(container.querySelectorAll<HTMLInputElement>('[role="switch"]'))
    expect(switches.map(input => input.getAttribute('aria-label'))).toEqual(['自动滚动', '折叠重复日志'])
    expect(switches.every(input => input.checked)).toBe(true)
  })

  it('keeps existing realtime rows visible when a background refresh fails', async () => {
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({
        success: true,
        data: [{ time: '2026-07-22T10:11:12.000Z', level: 'INFO', message: '保留这条实时日志' }],
      })
      .mockResolvedValueOnce({ success: false, message: '后台刷新暂不可用' })

    await renderComponent()
    expect(container.querySelector('.log-row')?.textContent).toContain('保留这条实时日志')

    visibility = 'hidden'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await flush()
    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await flush()

    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.log-console-state.is-error')?.textContent).toContain('后台刷新暂不可用')
    expect(container.querySelector('.log-row')?.textContent).toContain('保留这条实时日志')
  })

  it('offers retry for both the history list and a selected history file', async () => {
    const historyFile = {
      name: 'maa.log',
      path: '/logs/maa.log',
      modified: '2026-07-22T10:00:00.000Z',
      size: 1024,
    }
    mocks.getLogFiles
      .mockResolvedValueOnce({ success: false, message: '历史列表读取失败' })
      .mockResolvedValueOnce({ success: true, data: [historyFile] })
    mocks.readLogFile
      .mockResolvedValueOnce({ success: false, message: '日志文件读取失败' })
      .mockResolvedValueOnce({ success: true, data: { content: '[2026-07-22 10:11:12][INFO] recovered' } })

    await renderComponent()
    const historyError = container.querySelector<HTMLElement>('.log-history-state.is-error')
    expect(historyError?.textContent).toContain('历史列表读取失败')
    expect(container.textContent).not.toContain('暂无历史日志文件')
    const historyRetry = historyError?.querySelector<HTMLButtonElement>('button')
    expect(historyRetry).not.toBeNull()
    await click(historyRetry!)

    const historyRow = container.querySelector<HTMLButtonElement>('.log-history-row')
    expect(historyRow?.textContent).toContain('maa.log')
    await click(historyRow!)
    expect(historyRow?.getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('.log-console-content .surface-soft')?.textContent).toContain('maa.log')

    const fileError = container.querySelector<HTMLElement>('.log-console-state.is-error')
    expect(fileError?.textContent).toContain('日志文件读取失败')
    const fileRetry = fileError?.querySelector<HTMLButtonElement>('button')
    expect(fileRetry).not.toBeNull()
    await click(fileRetry!)

    expect(mocks.readLogFile).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.log-console-state.is-error')).toBeNull()
    expect(container.textContent).toContain('recovered')
  })

  it('returns to realtime with a fresh read and no stale history content', async () => {
    const target = historyFile('maa.log')
    const returned = deferred<ApiResponse<unknown>>()
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [target] })
    mocks.readLogFile.mockResolvedValue({
      success: true,
      data: { content: historyLine('历史内容') },
    })
    mocks.getRealtimeLogs
      .mockResolvedValueOnce({
        success: true,
        data: [{ time: '2026-07-22T10:11:12', level: 'INFO', message: '进入前' }],
      })
      .mockReturnValueOnce(returned.promise)

    await renderComponent()
    expect(container.textContent).toContain('进入前')
    const autoScroll = () => Array.from(container.querySelectorAll<HTMLInputElement>('[role="switch"]'))
      .find(input => input.getAttribute('aria-label') === '自动滚动')
    expect(autoScroll()?.checked).toBe(true)

    await click(container.querySelector<HTMLButtonElement>('.log-history-row')!)
    expect(mocks.readLogFile).toHaveBeenCalledWith(target.path, 1000, expect.any(AbortSignal))
    expect(container.textContent).toContain('历史内容')
    expect(autoScroll()?.checked).toBe(false)
    expect(autoScroll()?.disabled).toBe(true)

    const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '返回实时')
    await click(back!)

    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('历史内容')
    expect(container.textContent).not.toContain('进入前')
    expect(autoScroll()?.checked).toBe(true)
    expect(autoScroll()?.disabled).toBe(false)

    returned.resolve({
      success: true,
      data: [{ time: '2026-07-22T10:11:12', level: 'INFO', message: '返回后' }],
    })
    await flush()
    expect(container.textContent).toContain('返回后')
  })

  it('keeps the newest selection when an older history read resolves late', async () => {
    const olderFile = historyFile('older.log')
    const newerFile = historyFile('newer.log')
    const older = deferred<ApiResponse<unknown>>()
    const newer = deferred<ApiResponse<unknown>>()
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [olderFile, newerFile] })
    mocks.readLogFile.mockImplementation((path: string) => (
      path === olderFile.path ? older.promise : newer.promise
    ))

    await renderComponent()
    const rows = container.querySelectorAll<HTMLButtonElement>('.log-history-row')
    expect(rows).toHaveLength(2)
    await click(rows[0]!)
    await click(rows[1]!)

    newer.resolve({ success: true, data: { content: historyLine('新选择') } })
    await flush()
    expect(container.textContent).toContain('新选择')
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')

    older.resolve({ success: true, data: { content: historyLine('旧选择') } })
    await flush()
    expect(container.textContent).toContain('新选择')
    expect(container.textContent).not.toContain('旧选择')
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')
  })

  it('keeps content mode and auto-scroll across history switching and retry', async () => {
    const target = historyFile('maa.log')
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [target] })
    mocks.getRealtimeLogs.mockResolvedValue({ success: true, data: [] })
    mocks.readLogFile
      .mockResolvedValueOnce({ success: false, message: '日志文件读取失败' })
      .mockResolvedValueOnce({ success: true, data: { content: historyLine('原始模式内容') } })

    await renderComponent()
    const modeTabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.log-mode-shell [role="tab"]'))
    await click(modeTabs[1]!)
    expect(modeTabs[1]?.getAttribute('aria-selected')).toBe('true')
    const autoScroll = () => Array.from(container.querySelectorAll<HTMLInputElement>('[role="switch"]'))
      .find(input => input.getAttribute('aria-label') === '自动滚动')

    await click(container.querySelector<HTMLButtonElement>('.log-history-row')!)
    expect(autoScroll()?.checked).toBe(false)
    expect(autoScroll()?.disabled).toBe(true)
    expect(container.querySelector('.log-console-state.is-error')?.textContent).toContain('日志文件读取失败')

    await click(container.querySelector<HTMLButtonElement>('.log-console-state.is-error button')!)
    expect(container.textContent).toContain('原始模式内容')
    expect(modeTabs[1]?.getAttribute('aria-selected')).toBe('true')

    const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '返回实时')
    await click(back!)

    expect(autoScroll()?.checked).toBe(true)
    expect(autoScroll()?.disabled).toBe(false)
    expect(modeTabs[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps level filters across realtime and history views', async () => {
    const target = historyFile('maa.log')
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [target] })
    mocks.readLogFile.mockResolvedValue({
      success: true,
      data: {
        content: `${historyLine('历史普通行')}\n[2026-07-22 10:11:13][ERROR] 历史错误行`,
      },
    })
    mocks.getRealtimeLogs.mockResolvedValue({
      success: true,
      data: [
        { time: '2026-07-22T10:11:12', level: 'INFO', message: '实时普通行' },
        { time: '2026-07-22T10:11:13', level: 'ERROR', message: '实时错误行' },
      ],
    })

    await renderComponent()
    expect(container.textContent).toContain('实时普通行')
    const level = container.querySelector<HTMLSelectElement>('select[aria-label="日志级别"]')
    expect(level).not.toBeNull()
    await changeSelect(level!, 'ERROR')
    expect(container.textContent).toContain('实时错误行')
    expect(container.textContent).not.toContain('实时普通行')

    await click(container.querySelector<HTMLButtonElement>('.log-history-row')!)
    expect(container.textContent).toContain('历史错误行')
    expect(container.textContent).not.toContain('历史普通行')

    const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '返回实时')
    await click(back!)
    expect(level?.value).toBe('ERROR')
    expect(container.textContent).toContain('实时错误行')
    expect(container.textContent).not.toContain('实时普通行')
  })

  it('confirms cleanup, refreshes the file list and reports the result', async () => {
    const target = historyFile('maa.log')
    mocks.getLogFiles
      .mockResolvedValueOnce({ success: true, data: [target] })
      .mockResolvedValueOnce({ success: true, data: [] })
    mocks.cleanupLogs.mockResolvedValue({ success: true, message: '已清理 1 个日志文件' })

    await renderComponent()
    expect(container.querySelector('.log-history-row')).not.toBeNull()

    const cleanup = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清理旧日志')
    await click(cleanup!)
    expect(document.body.textContent).toContain('清理旧日志文件？')

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清理')
    await click(confirm!)

    expect(mocks.cleanupLogs).toHaveBeenCalledWith(10, expect.any(AbortSignal))
    expect(mocks.getLogFiles).toHaveBeenCalledTimes(2)
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已清理 1 个日志文件')
    expect(container.textContent).toContain('暂无历史日志文件')
  })

  it('keeps the cleanup dialog open after a failure and allows retrying', async () => {
    const target = historyFile('maa.log')
    mocks.getLogFiles.mockResolvedValue({ success: true, data: [target] })
    mocks.cleanupLogs
      .mockResolvedValueOnce({ success: false, message: '清理接口暂不可用' })
      .mockResolvedValueOnce({ success: true, message: '清理完成' })

    await renderComponent()
    const cleanup = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清理旧日志')
    await click(cleanup!)
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清理')
    await click(confirm!)

    expect(document.body.textContent).toContain('清理接口暂不可用')
    expect(document.body.textContent).toContain('清理旧日志文件？')
    expect(container.textContent).toContain('清理接口暂不可用')
    expect(mocks.getLogFiles).toHaveBeenCalledTimes(1)

    const retryConfirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清理')
    await click(retryConfirm!)

    expect(mocks.cleanupLogs).toHaveBeenCalledTimes(2)
    expect(mocks.getLogFiles).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('清理完成')
  })

  it('keeps realtime rows when clearing fails and resumes polling', async () => {
    mocks.getRealtimeLogs.mockResolvedValue({
      success: true,
      data: [{ time: '2026-07-22T10:11:12', level: 'INFO', message: '清空失败前的行' }],
    })
    mocks.clearRealtimeLogs.mockResolvedValueOnce({
      success: false,
      message: '清空接口暂不可用',
    })

    await renderComponent()
    expect(container.textContent).toContain('清空失败前的行')

    const clear = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '清空')
    await click(clear!)
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '确认清空')
    await click(confirm!)

    expect(container.textContent).toContain('清空接口暂不可用')
    expect(container.textContent).toContain('清空失败前的行')
    expect(mocks.getRealtimeLogs).toHaveBeenCalledTimes(2)
    expect(mocks.getLogFiles).toHaveBeenCalledTimes(1)
  })
})
