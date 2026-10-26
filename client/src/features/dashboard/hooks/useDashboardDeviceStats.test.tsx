// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import { useDashboardStore } from '../store/dashboardStore'
import { useDashboardDeviceStats } from './useDashboardDeviceStats'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  getDeviceStats: vi.fn(),
}))

vi.mock('@/features/device-mirror/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/device-mirror/api')>()
  return { ...actual, getDeviceStats: apiMocks.getDeviceStats }
})

function Harness() {
  useDashboardDeviceStats()
  return null
}

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const renderActivity = async (mode: 'visible' | 'hidden') => {
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

const history = () => useDashboardStore.getState().temperatureHistory

describe('useDashboardDeviceStats', () => {
  beforeEach(() => {
    onlineManager.setOnline(true)
    apiMocks.getDeviceStats.mockReset()
    useDashboardStore.getState().reset()
    client = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useDashboardStore.getState().reset()
    onlineManager.setOnline(true)
  })

  it('projects the first sample and appends only a new timestamp after Activity restore', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })

    await renderActivity('visible')
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(1)
    expect(history()).toEqual([38])

    let resolveRestored: ((value: { success: boolean; data: { cpuPct: number; temp: number } }) => void) | undefined
    apiMocks.getDeviceStats.mockReturnValueOnce(new Promise(resolve => {
      resolveRestored = resolve
    }))

    await renderActivity('hidden')
    await renderActivity('visible')
    // 恢复时 Query 先回放缓存样本，同一 dataUpdatedAt 不应重复追加温度点；
    // 新请求在途，尚未产生新样本。
    expect(apiMocks.getDeviceStats).toHaveBeenCalledTimes(2)
    expect(history()).toEqual([38])

    await act(async () => resolveRestored?.({ success: true, data: { cpuPct: 41, temp: 39 } }))
    await flush()

    expect(history()).toEqual([38, 39])
    expect(useDashboardStore.getState().deviceStats).toEqual({ cpuPct: 41, temp: 39 })
  })

  it('keeps the last sample when the projected payload is null', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })
    await renderActivity('visible')
    expect(history()).toEqual([38])

    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: null })
    await renderActivity('hidden')
    await renderActivity('visible')
    await flush()

    expect(useDashboardStore.getState().deviceStats).toEqual({ cpuPct: 42, temp: 38 })
    expect(history()).toEqual([38])
  })
})
