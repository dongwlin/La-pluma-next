// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  CONFIG_SECTION_EVENT,
  CONFIG_SECTION_STORAGE_KEY,
  DEFAULT_CONFIG_SECTION,
  isConfigSectionId,
  isEditableConfigSection,
  readConfigSection,
  subscribeConfigSection,
  writeConfigSection,
} from './configSection'

const createStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    values,
  }
}

describe('config section state', () => {
  it('keeps the existing storage key and window event names', () => {
    expect(CONFIG_SECTION_STORAGE_KEY).toBe('laPlumaConfigSection')
    expect(CONFIG_SECTION_EVENT).toBe('la-pluma-config-section')
    expect(DEFAULT_CONFIG_SECTION).toBe('connection')
  })

  it('reads only known sections and falls back to connection', () => {
    expect(readConfigSection(createStorage({ [CONFIG_SECTION_STORAGE_KEY]: 'resource' }))).toBe('resource')
    expect(readConfigSection(createStorage({ [CONFIG_SECTION_STORAGE_KEY]: 'unknown' }))).toBe('connection')
    expect(readConfigSection(createStorage())).toBe('connection')
    expect(readConfigSection({
      getItem: () => {
        throw new Error('storage unavailable')
      },
    })).toBe('connection')
  })

  it('persists section changes without propagating storage failures', () => {
    const storage = createStorage()
    writeConfigSection('instance', storage)
    expect(storage.values.get(CONFIG_SECTION_STORAGE_KEY)).toBe('instance')

    expect(() => writeConfigSection('resource', {
      setItem: () => {
        throw new Error('storage unavailable')
      },
    })).not.toThrow()
  })

  it('keeps only connection editable', () => {
    expect(isConfigSectionId('connection')).toBe(true)
    expect(isConfigSectionId('resource')).toBe(true)
    expect(isConfigSectionId('instance')).toBe(true)
    expect(isConfigSectionId('updates')).toBe(false)
    expect(isEditableConfigSection('connection')).toBe(true)
    expect(isEditableConfigSection('resource')).toBe(false)
    expect(isEditableConfigSection('instance')).toBe(false)
  })

  it('subscribes to valid section events and unsubscribes cleanly', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeConfigSection(listener)

    window.dispatchEvent(new CustomEvent(CONFIG_SECTION_EVENT, { detail: 'resource' }))
    expect(listener).toHaveBeenCalledWith('resource')

    window.dispatchEvent(new CustomEvent(CONFIG_SECTION_EVENT, { detail: 'unknown' }))
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    window.dispatchEvent(new CustomEvent(CONFIG_SECTION_EVENT, { detail: 'instance' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
