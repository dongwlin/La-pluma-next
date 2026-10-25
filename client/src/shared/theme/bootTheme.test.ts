// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  createBootScript,
  readStoredTheme,
  resolveDark,
  THEME_STORAGE_KEY,
} from './bootTheme'

let systemDark = false

function installThemeEnvironment() {
  systemDark = false
  window.localStorage.clear()
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
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = '<div id="app-root"></div>'
  document.head.innerHTML = [
    '<meta name="theme-color" content="" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="" />',
  ].join('')
}

describe('readStoredTheme', () => {
  it.each(['light', 'dark', 'system'] as const)('reads the stored %s preference', (theme) => {
    expect(readStoredTheme(JSON.stringify({ state: { theme } }))).toBe(theme)
  })

  it('falls back to dark for unsupported or missing state', () => {
    expect(readStoredTheme(JSON.stringify({ state: { theme: 'sepia' } }))).toBe('dark')
    expect(readStoredTheme(JSON.stringify({ state: {} }))).toBe('dark')
    expect(readStoredTheme(JSON.stringify({}))).toBe('dark')
    expect(readStoredTheme(null)).toBe('dark')
  })

  it('falls back to dark when the persisted JSON is corrupt', () => {
    expect(readStoredTheme('{invalid-json')).toBe('dark')
  })
})

describe('resolveDark', () => {
  it('resolves explicit themes and the system preference independently', () => {
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('light', true)).toBe(false)
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
})

describe('applyTheme', () => {
  beforeEach(installThemeEnvironment)

  it.each([
    {
      theme: 'light',
      systemDark: false,
      dark: false,
      background: 'rgb(242, 242, 247)',
      themeColor: '#f6f8fb',
      statusBar: 'default',
    },
    {
      theme: 'dark',
      systemDark: false,
      dark: true,
      background: 'rgb(0, 0, 0)',
      themeColor: '#05090c',
      statusBar: 'black-translucent',
    },
    {
      theme: 'system',
      systemDark: true,
      dark: true,
      background: 'rgb(0, 0, 0)',
      themeColor: '#05090c',
      statusBar: 'black-translucent',
    },
    {
      theme: 'system',
      systemDark: false,
      dark: false,
      background: 'rgb(242, 242, 247)',
      themeColor: '#f6f8fb',
      statusBar: 'default',
    },
  ] as const)('applies $theme with systemDark=$systemDark', ({
    theme,
    systemDark: prefersDark,
    dark,
    background,
    themeColor,
    statusBar,
  }) => {
    systemDark = prefersDark

    applyTheme(theme)

    expect(document.documentElement.classList.contains('dark')).toBe(dark)
    expect(document.getElementById('app-root')?.classList.contains('dark')).toBe(dark)
    expect(document.documentElement.style.colorScheme).toBe(dark ? 'dark' : 'light')
    expect(document.documentElement.style.backgroundColor).toBe(background)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(themeColor)
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe(statusBar)
  })
})

describe('createBootScript', () => {
  beforeEach(installThemeEnvironment)

  it('boots into the dark default when no preference is stored', () => {
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()

    window.eval(createBootScript())

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.style.backgroundColor).toBe('rgb(0, 0, 0)')
  })
})
