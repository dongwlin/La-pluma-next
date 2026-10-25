// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageSkeleton } from './Loading'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const SKELETON_VARIANTS = ['automation', 'combat', 'roguelike', 'training', 'logs', 'statistics', 'config']

describe('PageSkeleton', () => {
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

  it.each(SKELETON_VARIANTS)('exposes the %s placeholder as a busy region and hides its chrome', async (variant) => {
    await act(async () => root.render(<PageSkeleton variant={variant} />))

    const region = container.querySelector('[aria-busy="true"][aria-label="页面内容加载中"]')
    expect(region).not.toBeNull()
    expect(region?.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
