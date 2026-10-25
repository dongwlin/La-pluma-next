// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_UPDATE_CONFIG,
  DEFAULT_CONNECTION_CONFIG,
  connectionConfigsEqual,
  isValidUpdateTime,
  normalizeAutoUpdateConfig,
  normalizeConnectionConfig,
} from './configNormalization'

describe('connection config normalization', () => {
  it('uses the settings page defaults for missing or invalid fields', () => {
    expect(normalizeConnectionConfig({})).toEqual(DEFAULT_CONNECTION_CONFIG)
    expect(normalizeConnectionConfig({
      adb_path: 7,
      address: false,
      config: null,
      auto_reconnect: 'yes',
    })).toEqual(DEFAULT_CONNECTION_CONFIG)
  })

  it('keeps valid values and unknown connection fields for the save snapshot', () => {
    expect(normalizeConnectionConfig({
      adb_path: '/usr/bin/adb',
      address: '127.0.0.1:5555',
      config: 'General',
      auto_reconnect: false,
      touch_mode: 'minitouch',
    })).toEqual({
      adb_path: '/usr/bin/adb',
      address: '127.0.0.1:5555',
      config: 'General',
      auto_reconnect: false,
      touch_mode: 'minitouch',
    })
  })

  it('rejects a non-object payload instead of inventing a connection', () => {
    expect(normalizeConnectionConfig(null)).toBeNull()
    expect(normalizeConnectionConfig('adb')).toBeNull()
    expect(normalizeConnectionConfig([])).toBeNull()
  })

  it('compares the full normalized draft, including unknown fields', () => {
    const base = { ...DEFAULT_CONNECTION_CONFIG }

    expect(connectionConfigsEqual(base, { ...base })).toBe(true)
    expect(connectionConfigsEqual(base, { ...base, address: '10.0.0.2:5555' })).toBe(false)
    expect(connectionConfigsEqual(base, { ...base, touch_mode: 'minitouch' })).toBe(false)
  })
})

describe('auto-update config normalization', () => {
  it('uses the documented defaults for a partial payload', () => {
    expect(normalizeAutoUpdateConfig({})).toEqual(DEFAULT_AUTO_UPDATE_CONFIG)
    expect(normalizeAutoUpdateConfig({
      enabled: 1,
      time: 400,
      updateCore: 'yes',
      updateCli: null,
    })).toEqual(DEFAULT_AUTO_UPDATE_CONFIG)
  })

  it('keeps valid fields and rejects non-object payloads', () => {
    expect(normalizeAutoUpdateConfig({
      enabled: true,
      time: '05:30',
      updateCore: false,
      updateCli: true,
    })).toEqual({
      enabled: true,
      time: '05:30',
      updateCore: false,
      updateCli: true,
    })
    expect(normalizeAutoUpdateConfig(null)).toBeNull()
    expect(normalizeAutoUpdateConfig('auto-update')).toBeNull()
  })

  it('validates only 00:00–23:59 HH:MM values', () => {
    expect(isValidUpdateTime('00:00')).toBe(true)
    expect(isValidUpdateTime('23:59')).toBe(true)
    expect(isValidUpdateTime('24:00')).toBe(false)
    expect(isValidUpdateTime('9:00')).toBe(false)
    expect(isValidUpdateTime('12:60')).toBe(false)
    expect(isValidUpdateTime('')).toBe(false)
  })
})
