// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import { useDeviceStatsSample } from './useDeviceStatsSample'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  getDeviceStats: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

function Harness() {
  const { data } = useDeviceStatsSample()
  return <output data-testid="sample">{data ? String(data.temp ?? '--') : 'none'}</output>
}

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  })
}

const render = async (mode: 'visible' | 'hidden') => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Activity mode={mode}>
          <Harness />
        </Activity>
      </QueryClientProvider>,
    )
  })
  await flush()
}

const sample = () => container.querySelector('[data-testid="sample"]')?.textContent

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

describe('useDeviceStatsSample', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    onlineManager.setOnline(true)
    apiMocks.getDeviceStats.mockReset()
    client = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    onlineManager.setOnline(true)
  })

  it('keeps the latest sample while polling continues to fail', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })

    await render('visible')
    expect(sample()).toBe('38')
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(1)

    await advance(5_000)
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(2)
    expect(sample()).toBe('38')

    apiMocks.getDeviceStats.mockResolvedValue({ success: false, message: '设备不可用' })
    await advance(5_000)

    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(3)
    expect(sample()).toBe('38')
  })

  it('stops polling while Activity is hidden and resumes with one timer', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })

    await render('visible')
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(1)
    await advance(5_000)
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(2)

    const callsBeforeHide = apiMocks.getDeviceStats.mock.calls.length
    await render('hidden')
    await advance(20_000)
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(callsBeforeHide)

    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 12, temp: 39 } })
    await render('visible')

    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(callsBeforeHide + 1)
    expect(sample()).toBe('39')

    // 恢复后每次间隔只产生一次请求，不会叠加隐藏前的计时器。
    await advance(5_000)
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(callsBeforeHide + 2)
    await advance(5_000)
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(callsBeforeHide + 3)
  })

  it('ignores a null device payload instead of clearing the last sample', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })

    await render('visible')
    expect(sample()).toBe('38')

    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: null })
    await advance(5_000)

    expect(sample()).toBe('38')
  })
})
