// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardSkeleton } from './DashboardSkeleton'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('DashboardSkeleton', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const expectCurrentPageHeader = () => {
    const header = container.querySelector('.app-page-header.is-mobile-inline')
    expect(header).not.toBeNull()
    expect(header?.querySelector('.app-page-heading')).not.toBeNull()
    expect(header?.querySelector('.app-page-actions')).not.toBeNull()
    expect(header?.querySelector('.app-page-header-icon')).toBeNull()
  }

  it('keeps dashboard material styling while data is loading', async () => {
    await act(async () => root.render(<DashboardSkeleton />))

    const page = container.querySelector('[aria-label="概览加载中"]')
    expect(page?.classList.contains('dashboard-page')).toBe(true)
    expectCurrentPageHeader()
    expect(page?.querySelector('.dashboard-flow-card')).not.toBeNull()
    expect(page?.querySelectorAll('.dashboard-flow-actions > .app-skeleton')).toHaveLength(2)
    expect(page?.querySelector('[data-dashboard-preview-card].status-border-beam')).not.toBeNull()
    expect(page?.querySelectorAll('.dashboard-device-card-shell')).toHaveLength(4)
    expect(page?.querySelectorAll('.dashboard-temperature-skeleton')).toHaveLength(1)
    expect(page?.querySelectorAll('.dashboard-summary-card')).toHaveLength(2)
    expect(page?.querySelector('.dashboard-summary-card.is-training')).not.toBeNull()
    expect(page?.querySelector('.dashboard-summary-card.is-drops')).not.toBeNull()
  })
})
