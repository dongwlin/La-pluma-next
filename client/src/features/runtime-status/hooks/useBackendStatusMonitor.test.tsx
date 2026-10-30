// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalRunStatus } from '@/features/task-execution'
import { useStatusStore } from '../store/statusStore'
import {
  invalidateBackendStatusProbe,
  probeBackendAvailability,
  useBackendStatusMonitor,
} from './useBackendStatusMonitor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
}))

vi.mock('@/features/task-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  return { ...actual, getTaskStatus: apiMocks.getTaskStatus }
})

interface ProbeResult {
  success: boolean
  message?: string
  data?: { isRunning: boolean }
}

const IDLE: GlobalRunStatus = { phase: 'idle', isRunning: false, runId: null, label: null, detail: null }
const RUNNING: GlobalRunStatus = {
  phase: 'running',
  isRunning: true,
  runId: 'run-1',
  label: '正在执行: 收取信用',
  detail: '今日流程执行中',
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

function HookHarness() {
  useBackendStatusMonitor()
  return null
}

let online = true
let visibility: DocumentVisibilityState = 'visible'
let container: HTMLDivElement
let root: Root

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setDocumentVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useBackendStatusMonitor', () => {
  beforeEach(() => {
    online = true
    visibility = 'visible'
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    apiMocks.getTaskStatus.mockReset()
    useStatusStore.getState().setBackendStatus('unknown')
    useStatusStore.getState().applyRunStatus(IDLE)
    invalidateBackendStatusProbe()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (document as unknown as Record<string, unknown>).visibilityState
    vi.useRealTimers()
    useStatusStore.getState().setBackendStatus('unknown')
    useStatusStore.getState().applyRunStatus(IDLE)
    invalidateBackendStatusProbe()
  })

  it('probes immediately on mount and publishes availability', async () => {
    const request = deferred<ProbeResult>()
    apiMocks.getTaskStatus.mockReturnValueOnce(request.promise)

    act(() => root.render(<HookHarness />))

    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(1)
    expect(apiMocks.getTaskStatus).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(useStatusStore.getState().backendStatus).toBe('checking')

    request.resolve({ success: true, data: { isRunning: false } })
    await flushEffects()

    expect(useStatusStore.getState().backendStatus).toBe('available')
  })

  it('switches to checking immediately when the browser comes back online', async () => {
    online = false
    useStatusStore.getState().setBackendStatus('unavailable', '后端服务不可用')
    const request = deferred<ProbeResult>()
    apiMocks.getTaskStatus.mockReturnValueOnce(request.promise)

    act(() => root.render(<HookHarness />))
    expect(apiMocks.getTaskStatus).not.toHaveBeenCalled()

    online = true
    act(() => window.dispatchEvent(new Event('online')))

    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(1)
    expect(useStatusStore.getState().backendStatus).toBe('checking')
    expect(useStatusStore.getState().backendMessage).toBe('')

    request.resolve({ success: true, data: { isRunning: false } })
    await flushEffects()
  })

  it('does not let an older failed probe overwrite a newer success', async () => {
    const olderRequest = deferred<ProbeResult>()
    const newerRequest = deferred<ProbeResult>()
    apiMocks.getTaskStatus
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise)

    const olderProbe = probeBackendAvailability({ showChecking: false })
    const newerProbe = probeBackendAvailability({ showChecking: false })

    newerRequest.resolve({ success: true, data: { isRunning: false } })
    await expect(newerProbe).resolves.toBe(true)
    expect(useStatusStore.getState().backendStatus).toBe('available')

    olderRequest.reject(new Error('较旧请求失败'))
    await expect(olderProbe).resolves.toBe(true)

    expect(useStatusStore.getState().backendStatus).toBe('available')
    expect(useStatusStore.getState().backendMessage).toBe('')
  })

  it('never writes run state from the legacy task probe', async () => {
    useStatusStore.getState().applyRunStatus(RUNNING)
    apiMocks.getTaskStatus
      .mockResolvedValueOnce({ success: true, data: { isRunning: false } })
      .mockResolvedValueOnce({ success: true, data: { isRunning: true } })

    await expect(probeBackendAvailability({ showChecking: false })).resolves.toBe(true)
    expect(useStatusStore.getState().runStatus).toEqual(RUNNING)

    await expect(probeBackendAvailability({ showChecking: false })).resolves.toBe(true)
    expect(useStatusStore.getState().runStatus).toEqual(RUNNING)
    expect(useStatusStore.getState().backendStatus).toBe('available')
  })

  it('probes at the active cadence while the projected run keeps the device busy', async () => {
    vi.useFakeTimers()
    apiMocks.getTaskStatus.mockResolvedValue({ success: true, data: { isRunning: false } })

    act(() => root.render(<HookHarness />))
    await flushEffects()
    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(2)

    act(() => useStatusStore.getState().applyRunStatus(RUNNING))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(3)
  })

  it('pauses probing while the document is hidden and refreshes when it becomes visible', async () => {
    vi.useFakeTimers()
    apiMocks.getTaskStatus.mockResolvedValue({ success: true, data: { isRunning: false } })
    visibility = 'hidden'

    act(() => root.render(<HookHarness />))
    await flushEffects()
    expect(apiMocks.getTaskStatus).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiMocks.getTaskStatus).not.toHaveBeenCalled()

    await act(async () => setDocumentVisibility('visible'))
    await flushEffects()
    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(2)
  })

  it('does not notify store subscribers when a repeated probe keeps the same availability', async () => {
    apiMocks.getTaskStatus.mockResolvedValue({ success: true, data: { isRunning: false } })
    await expect(probeBackendAvailability({ showChecking: false })).resolves.toBe(true)
    expect(useStatusStore.getState().backendStatus).toBe('available')

    const subscriber = vi.fn()
    const unsubscribe = useStatusStore.subscribe(subscriber)
    await expect(probeBackendAvailability({ showChecking: false })).resolves.toBe(true)

    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()
  })
})
