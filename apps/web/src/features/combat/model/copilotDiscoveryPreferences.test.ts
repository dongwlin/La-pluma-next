// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COPILOT_DISCOVERY_VIEW_STORAGE_KEY,
  COPILOT_MATCH_STORAGE_KEY,
  COPILOT_OPERATOR_FILTER_STORAGE_KEY,
  parseCopilotMatchPreference,
  readCopilotDiscoveryViewPreference,
  readCopilotMatchPreference,
  readCopilotOperatorFilterPreference,
  writeCopilotDiscoveryViewPreference,
  writeCopilotMatchPreference,
  writeCopilotOperatorFilterPreference,
} from './copilotDiscoveryPreferences'

describe('copilotDiscoveryPreferences', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('round-trips the operator filter, enabled flag and remember flag', () => {
    writeCopilotOperatorFilterPreference({
      selection: { included: ['阿米娅'], excluded: ['陈'] },
      enabled: false,
      remember: true,
    })

    expect(readCopilotOperatorFilterPreference()).toEqual({
      selection: { included: ['阿米娅'], excluded: ['陈'] },
      enabled: false,
      remember: true,
    })
  })

  it('normalizes duplicate and conflicting operator names on read', () => {
    localStorage.setItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY, JSON.stringify({
      included: [' 阿米娅 ', '阿米娅', '凯尔希'],
      excluded: ['阿米娅', '陈'],
      enabled: true,
      remember: true,
    }))

    expect(readCopilotOperatorFilterPreference()?.selection).toEqual({
      included: ['阿米娅', '凯尔希'],
      excluded: ['陈'],
    })
  })

  it('keeps the opt-out choice without restoring the previous selection', () => {
    localStorage.setItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY, JSON.stringify({
      included: ['阿米娅'],
      excluded: [],
      enabled: true,
      remember: true,
    }))

    writeCopilotOperatorFilterPreference({
      selection: { included: ['阿米娅'], excluded: [] },
      enabled: true,
      remember: false,
    })

    expect(JSON.parse(localStorage.getItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY) ?? 'null'))
      .toMatchObject({ included: [], excluded: [], remember: false })
    expect(readCopilotOperatorFilterPreference()).toEqual({
      selection: { included: [], excluded: [] },
      enabled: true,
      remember: false,
    })
  })

  it('drops an empty remembered filter instead of storing an empty preference', () => {
    localStorage.setItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY, JSON.stringify({
      included: ['阿米娅'],
      excluded: [],
      enabled: true,
      remember: true,
    }))

    writeCopilotOperatorFilterPreference({
      selection: { included: [], excluded: [] },
      enabled: true,
      remember: true,
    })

    expect(localStorage.getItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY)).toBeNull()
  })

  it('survives corrupt operator filter payloads and clears them', () => {
    localStorage.setItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY, '{not-json')

    expect(readCopilotOperatorFilterPreference()).toBeNull()
    expect(localStorage.getItem(COPILOT_OPERATOR_FILTER_STORAGE_KEY)).toBeNull()
  })

  it('parses only known match modes and preserves an explicit empty set', () => {
    expect(parseCopilotMatchPreference({
      enabled: true,
      modes: ['ready', 'unknown', 'blocked'],
    })).toEqual({ enabled: true, modes: ['ready', 'blocked'] })

    expect(parseCopilotMatchPreference({ enabled: false, modes: [] })).toEqual({
      enabled: false,
      modes: [],
    })
    expect(parseCopilotMatchPreference({ enabled: false })).toEqual({
      enabled: false,
      modes: ['ready', 'borrow', 'train', 'check'],
    })
    expect(parseCopilotMatchPreference({ enabled: 'yes', modes: ['ready'] })).toEqual({
      enabled: false,
      modes: ['ready'],
    })
    expect(parseCopilotMatchPreference(null)).toBeNull()
  })

  it('round-trips the match settings', () => {
    writeCopilotMatchPreference({ enabled: true, modes: ['train', 'check'] })

    expect(readCopilotMatchPreference()).toEqual({ enabled: true, modes: ['train', 'check'] })
  })

  it('round-trips the discovery view and rejects unknown values', () => {
    writeCopilotDiscoveryViewPreference('list')
    expect(readCopilotDiscoveryViewPreference()).toBe('list')

    localStorage.setItem(COPILOT_DISCOVERY_VIEW_STORAGE_KEY, JSON.stringify('table'))
    expect(readCopilotDiscoveryViewPreference()).toBeNull()

    localStorage.setItem(COPILOT_MATCH_STORAGE_KEY, '{broken')
    expect(readCopilotMatchPreference()).toBeNull()
  })

  it('keeps working when storage writes or reads throw', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readCopilotOperatorFilterPreference()).toBeNull()
    getItem.mockRestore()

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => writeCopilotMatchPreference({ enabled: true, modes: ['ready'] })).not.toThrow()
    setItem.mockRestore()
  })
})
