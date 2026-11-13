// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import { RealtimeLogStream } from '../model/realtimeLogStream'
import { useRealtimeLogs } from './useRealtimeLogs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realtimeRow = (message: string) => ({
  time: '2026-07-22T10:11:12',
  level: 'INFO',
  message,
})

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

function Harness({
  stream,
  enabled = true,
}: {
  stream: RealtimeLogStream
  enabled?: boolean
}) {
  const realtime = useRealtimeLogs({ stream, enabled })
  return (
    <div>
      <span data-testid="paused">{realtime.paused ? 'paused' : 'live'}</span>
      <span data-testid="logs">{realtime.logs.map(log => log.message).join('|')}</span>
      <button type="button" onClick={realtime.pause}>pause</button>
      <button type="button" onClick={realtime.resume}>resume</button>
      <button type="button" onClick={realtime.clear}>clear</button>
    </div>
  )
}

let visibility: DocumentVisibilityState
let container: HTMLDivElement
let root: Root

const click = async (name: string) => {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent === name)
  await act(async () => button?.click())
  await flush()
}

const setVisibility = async (state: DocumentVisibilityState) => {
  visibility = state
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await flush()
}

describe('useRealtimeLogs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps a manual pause across visibility changes and refreshes on resume', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValue({ success: true, data: [realtimeRow('实时行')] })
    const stream = new RealtimeLogStream({ read })

    await act(async () => root.render(<Harness stream={stream} />))
    await flush()
    expect(container.querySelector('[data-testid="logs"]')?.textContent).toBe('实时行')
    expect(read).toHaveBeenCalledTimes(1)

    await click('pause')
    expect(container.querySelector('[data-testid="paused"]')?.textContent).toBe('paused')
    await advance(5000)
    expect(read).toHaveBeenCalledTimes(1)

    await setVisibility('hidden')
    await setVisibility('visible')
    expect(container.querySelector('[data-testid="paused"]')?.textContent).toBe('paused')
    expect(read).toHaveBeenCalledTimes(1)

    await click('resume')
    expect(container.querySelector('[data-testid="paused"]')?.textContent).toBe('live')
    expect(read).toHaveBeenCalledTimes(2)

    await click('clear')
    expect(container.querySelector('[data-testid="logs"]')?.textContent).toBe('')
  })

  it('stops polling while disabled and refreshes immediately when enabled again', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValue({ success: true, data: [realtimeRow('历史模式')] })
    const stream = new RealtimeLogStream({ read })

    await act(async () => root.render(<Harness stream={stream} enabled={false} />))
    await flush()
    expect(read).not.toHaveBeenCalled()

    await act(async () => root.render(<Harness stream={stream} enabled />))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    await advance(1250)
    expect(read).toHaveBeenCalledTimes(2)

    await act(async () => root.render(<Harness stream={stream} enabled={false} />))
    await flush()
    await advance(5000)
    expect(read).toHaveBeenCalledTimes(2)

    await act(async () => root.render(<Harness stream={stream} enabled />))
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('aborts the in-flight read when the document becomes hidden', async () => {
    let resolveRead: ((value: ApiResponse<unknown>) => void) | undefined
    const pending = new Promise<ApiResponse<unknown>>(resolve => {
      resolveRead = resolve
    })
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ success: true, data: [realtimeRow('恢复')] })
    const stream = new RealtimeLogStream({ read })

    await act(async () => root.render(<Harness stream={stream} />))
    expect(read).toHaveBeenCalledTimes(1)
    const signal = read.mock.calls[0]?.[1]

    await setVisibility('hidden')
    expect(signal?.aborted).toBe(true)

    resolveRead?.({ success: true, data: [realtimeRow('隐藏期间返回')] })
    await flush()
    expect(container.querySelector('[data-testid="logs"]')?.textContent).toBe('')

    await setVisibility('visible')
    expect(read).toHaveBeenCalledTimes(2)
    await flush()
    expect(container.querySelector('[data-testid="logs"]')?.textContent).toBe('恢复')
  })
})
