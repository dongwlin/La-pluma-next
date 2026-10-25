// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REALTIME_LOG_INTERVAL_MS, REALTIME_LOG_LINES, RealtimeLogStream } from './realtimeLogStream'
import type { ApiResponse } from '@/shared/api'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const realtimeRow = (message: string) => ({
  time: '2026-07-22T10:11:12',
  level: 'INFO',
  message,
})

describe('RealtimeLogStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('reads 200 lines immediately and replaces the snapshot every 1250ms', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValue({ success: true, data: [realtimeRow('first')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[0]).toBe(REALTIME_LOG_LINES)
    expect(stream.getState().logs).toEqual([{ time: '10:11:12', level: 'INFO', message: 'first' }])
    expect(stream.getState().error).toBeNull()

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(3)

    read.mockResolvedValue({ success: true, data: [realtimeRow('second')] })
    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    expect(stream.getState().logs).toEqual([{ time: '10:11:12', level: 'INFO', message: 'second' }])

    stream.stop()
  })

  it('skips ticks while a slow request is in flight and resumes on the next tick', async () => {
    const slow = deferred<ApiResponse<unknown>>()
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue({ success: true, data: [realtimeRow('next')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS * 4)
    expect(read).toHaveBeenCalledTimes(1)

    slow.resolve({ success: true, data: [realtimeRow('slow')] })
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('slow')

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(2)
    expect(stream.getState().logs[0]?.message).toBe('next')

    stream.stop()
  })

  it('discards a stale response from before the page was hidden', async () => {
    const first = deferred<ApiResponse<unknown>>()
    const second = deferred<ApiResponse<unknown>>()
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const stream = new RealtimeLogStream({ read })

    stream.start()
    const firstSignal = read.mock.calls[0]?.[1]
    stream.stop()
    expect(firstSignal?.aborted).toBe(true)

    stream.start()
    expect(read).toHaveBeenCalledTimes(2)

    second.resolve({ success: true, data: [realtimeRow('current')] })
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('current')

    first.resolve({ success: true, data: [realtimeRow('stale')] })
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('current')

    stream.stop()
  })

  it('keeps the buffer on failure and clears the error after the next success', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce({ success: true, data: [realtimeRow('保留')] })
      .mockResolvedValueOnce({ success: false, message: '后台刷新暂不可用' })
      .mockResolvedValueOnce({ success: true, data: [realtimeRow('恢复')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('保留')

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('保留')
    expect(stream.getState().error).toBe('后台刷新暂不可用')

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('恢复')
    expect(stream.getState().error).toBeNull()

    stream.stop()
  })

  it('aborts an in-flight read while the document is hidden and reads immediately when visible', async () => {
    const hiddenRead = deferred<ApiResponse<unknown>>()
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce({ success: true, data: [realtimeRow('visible')] })
      .mockReturnValueOnce(hiddenRead.promise)
      .mockResolvedValueOnce({ success: true, data: [realtimeRow('restored')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await flush()
    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(2)
    const hiddenSignal = read.mock.calls[1]?.[1]

    stream.setDocumentVisible(false)
    expect(hiddenSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS * 4)
    expect(read).toHaveBeenCalledTimes(2)

    stream.setDocumentVisible(true)
    expect(read).toHaveBeenCalledTimes(3)
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('restored')

    hiddenRead.resolve({ success: true, data: [realtimeRow('stale-hidden')] })
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('restored')

    stream.stop()
  })

  it('pauses across visibility changes and reads immediately on manual resume', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValue({ success: true, data: [realtimeRow('paused-snapshot')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    stream.pause()
    expect(stream.getState().paused).toBe(true)
    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS * 4)
    expect(read).toHaveBeenCalledTimes(1)

    stream.setDocumentVisible(false)
    stream.setDocumentVisible(true)
    stream.stop()
    stream.start()
    expect(stream.getState().paused).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)

    stream.resume()
    expect(stream.getState().paused).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    await flush()

    stream.clear()
    expect(stream.getState().logs).toEqual([])
    expect(stream.getState().error).toBeNull()

    stream.stop()
  })

  it('cancels an in-flight read when manually paused', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ success: true, data: [realtimeRow('resumed')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    const signal = read.mock.calls[0]?.[1]
    stream.pause()
    expect(signal?.aborted).toBe(true)

    pending.resolve({ success: true, data: [realtimeRow('stale-pause')] })
    await flush()
    expect(stream.getState().logs).toEqual([])

    stream.resume()
    await flush()
    expect(stream.getState().logs[0]?.message).toBe('resumed')

    stream.stop()
  })

  it('does not poll while stopped and refreshes immediately on restart', async () => {
    const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValue({ success: true, data: [realtimeRow('once')] })
    const stream = new RealtimeLogStream({ read })

    stream.start()
    await flush()
    stream.stop()

    await vi.advanceTimersByTimeAsync(REALTIME_LOG_INTERVAL_MS * 4)
    expect(read).toHaveBeenCalledTimes(1)

    stream.start()
    expect(read).toHaveBeenCalledTimes(2)
    await flush()

    stream.stop()
  })
})
