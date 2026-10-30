// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '@/shared/query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DASHBOARD_REFRESH_INTERVAL_MS } from '../constants'
import { useDashboardStore } from '../store/dashboardStore'
import { useDashboardSnapshotRefresh } from './useDashboardSnapshotRefresh'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}))

vi.mock('../model/snapshotRefresher', () => ({
  dashboardSnapshotRefresher: { refresh: mocks.refresh },
}))

vi.mock('@/features/resource-invalidation', () => ({
  useResourceInvalidation: () => {},
}))

let visibility: DocumentVisibilityState = 'visible'
let container: HTMLDivElement
let root: Root
let queryClient: ReturnType<typeof createQueryClient>

function Harness() {
  useDashboardSnapshotRefresh()
  return null
}

function setDocumentVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

const renderHook = async () => {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  ))
  await flush()
}

describe('useDashboardSnapshotRefresh visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'))
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    useDashboardStore.getState().reset()
    queryClient = createQueryClient()
    useDashboardStore.setState({
      hasLoaded: true,
      lastRefreshAttemptAt: Date.now(),
      activitySummary: { available: true, status: 'none' },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (document as unknown as Record<string, unknown>).visibilityState
    useDashboardStore.getState().reset()
    queryClient.clear()
    vi.useRealTimers()
  })

  it('does not schedule while the document is hidden and refreshes on resume', async () => {
    visibility = 'hidden'
    await renderHook()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DASHBOARD_REFRESH_INTERVAL_MS * 2)
    })
    expect(mocks.refresh).not.toHaveBeenCalled()

    await act(async () => setDocumentVisibility('visible'))
    await flush()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('clears the scheduled refresh on hide and refreshes after becoming visible again', async () => {
    await renderHook()
    expect(mocks.refresh).not.toHaveBeenCalled()

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DASHBOARD_REFRESH_INTERVAL_MS * 2)
    })
    expect(mocks.refresh).not.toHaveBeenCalled()

    await act(async () => setDocumentVisibility('visible'))
    await flush()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
