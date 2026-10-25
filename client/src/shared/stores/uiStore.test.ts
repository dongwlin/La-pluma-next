// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyThemePreference, useUIStore } from './uiStore'

describe('UI theme state', () => {
  let systemDark = false

  beforeEach(() => {
    window.localStorage.clear()
    systemDark = false
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && systemDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    document.head.innerHTML = [
      '<meta name="theme-color" content="">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="">',
    ].join('')
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = ''
  })

  it('persists only the theme preference', () => {
    useUIStore.getState().setTheme('light')

    expect(useUIStore.getState().theme).toBe('light')
    const persisted = JSON.parse(window.localStorage.getItem('ui-storage') ?? '{}')
    expect(persisted.state).toEqual({ theme: 'light' })
  })

  it('ignores a persisted theme value that is not supported', async () => {
    useUIStore.getState().setTheme('dark')
    window.localStorage.setItem('ui-storage', JSON.stringify({
      state: { theme: 'sepia' },
      version: 0,
    }))

    await useUIStore.persist.rehydrate()

    expect(useUIStore.getState().theme).toBe('dark')
  })

  it('keeps class, color-scheme, and browser chrome in sync for system theme', () => {
    systemDark = true
    applyThemePreference('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#05090c')

    systemDark = false
    useUIStore.getState().setTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe('default')
  })
})
