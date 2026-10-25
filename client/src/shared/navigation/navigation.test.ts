// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_TABS,
  DEFAULT_APP_TAB,
  appTabFromPathname,
  appTabRoute,
  isAppTab,
  routerBasename,
} from './index'

describe('shared navigation vocabulary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('parses every supported tab from its router-relative path', () => {
    for (const tab of APP_TABS) {
      expect(appTabFromPathname(appTabRoute(tab))).toBe(tab)
    }
  })

  it('ignores trailing slashes', () => {
    expect(appTabFromPathname('/app/logs/')).toBe('logs')
    expect(appTabFromPathname('/app/logs///')).toBe('logs')
  })

  it('falls back to the default tab for a bare /app path', () => {
    expect(appTabFromPathname('/app')).toBe(DEFAULT_APP_TAB)
    expect(appTabFromPathname('/app/')).toBe(DEFAULT_APP_TAB)
  })

  it('tolerates deeper segments after a valid tab', () => {
    expect(appTabFromPathname('/app/logs/details')).toBe('logs')
    expect(appTabFromPathname('/app/statistics/2026/10')).toBe('statistics')
  })

  it('returns null for unknown tabs and non-app paths', () => {
    expect(appTabFromPathname('/app/not-a-tab')).toBeNull()
    expect(appTabFromPathname('/app/not-a-tab/details')).toBeNull()
    expect(appTabFromPathname('/')).toBeNull()
    expect(appTabFromPathname('')).toBeNull()
    expect(appTabFromPathname('/automation')).toBeNull()
    expect(appTabFromPathname('/application/logs')).toBeNull()
  })

  it('builds router-relative tab routes', () => {
    expect(appTabRoute('dashboard')).toBe('/app/dashboard')
    expect(appTabRoute('config')).toBe('/app/config')
    for (const tab of APP_TABS) {
      expect(appTabRoute(tab)).toBe(`/app/${tab}`)
    }
  })

  it('derives an empty basename for the default deployment base', () => {
    expect(routerBasename()).toBe('')
  })

  it('derives the basename without a trailing slash for a sub-path deployment', () => {
    vi.stubEnv('BASE_URL', '/la-pluma/')
    expect(routerBasename()).toBe('/la-pluma')
  })

  it('only accepts known tab ids', () => {
    for (const tab of APP_TABS) {
      expect(isAppTab(tab)).toBe(true)
    }
    expect(APP_TABS).toHaveLength(8)
    expect(isAppTab('not-a-tab')).toBe(false)
    expect(isAppTab(undefined)).toBe(false)
    expect(isAppTab(null)).toBe(false)
    expect(isAppTab(42)).toBe(false)
    expect(isAppTab({})).toBe(false)
  })
})
