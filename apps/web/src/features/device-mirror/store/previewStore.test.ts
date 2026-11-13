// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildScrcpyOptions, usePreviewStore } from './previewStore'
import { fpsOptions, qualityPresets } from '../constants'

const defaults = {
  mode: 'off' as const,
  quality: 'power' as const,
  fps: 15,
  maxSize: 640,
  bitrateMbps: 1.5,
}

function savePreferences(state: unknown, version = 2) {
  window.localStorage.setItem('preview-storage', JSON.stringify({ state, version }))
}

function saveUnversionedPreferences(state: unknown) {
  window.localStorage.setItem('preview-storage', JSON.stringify({ state }))
}

function savedPreferences() {
  return JSON.parse(window.localStorage.getItem('preview-storage') ?? '{}')
}

async function hydrateFrom(state: unknown, version = 2) {
  savePreferences(state, version)
  await usePreviewStore.persist.rehydrate()
}

describe('shared preview preferences', () => {
  beforeEach(() => {
    usePreviewStore.setState(defaults)
    window.localStorage.clear()
  })

  it('starts stopped with the power preset and offers low frame rates', () => {
    expect(usePreviewStore.getState()).toMatchObject(defaults)
    expect(usePreviewStore.getState()).not.toHaveProperty('autoStart')
    expect(fpsOptions).toEqual([10, 15, 30, 45, 60, 90, 120])
    expect(buildScrcpyOptions(usePreviewStore.getState())).toEqual({
      max_fps: 15,
      max_size: 640,
      bitrate: 1500000,
      min_bitrate: 1000000,
      max_bitrate: 3000000,
      bwe: true,
      audio: false,
      snapshot_interval: 10,
    })
  })

  it('shares preset changes and custom values across consumers', () => {
    const firstConsumer = usePreviewStore.getState()
    firstConsumer.setQuality('balanced')
    expect(usePreviewStore.getState()).toMatchObject({
      quality: 'balanced', fps: 45, maxSize: 1280, bitrateMbps: 8,
    })
    expect(buildScrcpyOptions(usePreviewStore.getState()).max_bitrate).toBe(16000000)

    firstConsumer.setCustomFps(10)
    firstConsumer.setCustomMaxSize(800)
    firstConsumer.setCustomBitrateMbps(1)
    expect(usePreviewStore.getState()).toMatchObject({
      quality: 'custom', fps: 10, maxSize: 800, bitrateMbps: 1,
    })
    expect(buildScrcpyOptions(usePreviewStore.getState())).toMatchObject({
      bitrate: 1000000, min_bitrate: 1000000, max_bitrate: 1000000,
    })

    firstConsumer.setQuality('power')
    firstConsumer.setQuality('custom')
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, quality: 'custom' })
  })

  it('saves the selected mode with the preferences', () => {
    usePreviewStore.getState().setMode('live')
    usePreviewStore.getState().setQuality('ultra')
    expect(usePreviewStore.getState().mode).toBe('live')
    expect(savedPreferences()).toEqual({
      version: 2,
      state: { ...defaults, mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
  })

  it('keeps the other tab quality when only the mode changes', async () => {
    await hydrateFrom(defaults)
    savePreferences({ ...defaults, quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 })

    usePreviewStore.getState().setMode('live')

    expect(savedPreferences()).toEqual({
      version: 2,
      state: { ...defaults, mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
    expect(usePreviewStore.getState()).toMatchObject({ mode: 'live', quality: 'power', fps: 15 })
  })

  it('keeps the other tab mode when only the quality changes', async () => {
    await hydrateFrom(defaults)
    savePreferences({ ...defaults, mode: 'live' })

    usePreviewStore.getState().setQuality('ultra')

    expect(savedPreferences()).toEqual({
      version: 2,
      state: { ...defaults, mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
  })

  it('merges custom frame rates over the other tab numeric settings', async () => {
    await hydrateFrom(defaults)
    savePreferences({ ...defaults, quality: 'crisp', fps: 60, maxSize: 1600, bitrateMbps: 14 })

    usePreviewStore.getState().setCustomFps(30)

    expect(savedPreferences().state).toEqual({
      mode: 'off', quality: 'custom', fps: 30, maxSize: 1600, bitrateMbps: 14,
    })
  })

  it('writes the whole preset selection as one preference change', async () => {
    await hydrateFrom(defaults)
    savePreferences({ ...defaults, mode: 'live', quality: 'crisp', fps: 60, maxSize: 1600, bitrateMbps: 14 })

    usePreviewStore.getState().setQuality('balanced')

    expect(savedPreferences().state).toEqual({
      mode: 'live', quality: 'balanced', fps: 45, maxSize: 1280, bitrateMbps: 8,
    })
  })

  it('falls back to the active preferences when the stored payload is unreadable', async () => {
    await hydrateFrom({ ...defaults, quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 })
    window.localStorage.setItem('preview-storage', '{invalid')

    usePreviewStore.getState().setMode('snapshot')

    expect(savedPreferences()).toEqual({
      version: 2,
      state: { mode: 'snapshot', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
  })

  it('keeps the active preferences when the stored envelope has no state', () => {
    usePreviewStore.setState({ quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 })
    window.localStorage.setItem('preview-storage', JSON.stringify({ version: 2 }))

    usePreviewStore.getState().setMode('live')

    expect(savedPreferences().state).toEqual({
      mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20,
    })
  })

  it('keeps the saved mode when the stored version is newer', () => {
    savePreferences({ ...defaults, mode: 'live' }, 3)

    usePreviewStore.getState().setQuality('ultra')

    expect(savedPreferences().state).toEqual({
      mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20,
    })
  })

  it('keeps preference actions working when storage access throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    try {
      expect(() => usePreviewStore.getState().setMode('live')).not.toThrow()
      expect(usePreviewStore.getState().mode).toBe('live')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('applies the legacy mode rule when merging over a version 1 payload', async () => {
    await hydrateFrom(defaults)
    savePreferences({ ...defaults, mode: 'live', autoStart: true }, 1)

    usePreviewStore.getState().setQuality('ultra')

    expect(savedPreferences()).toEqual({
      version: 2,
      state: { ...defaults, mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
  })

  it('restores the saved mode after loading', async () => {
    savePreferences({ ...defaults, mode: 'live' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'live' })

    savePreferences({ ...defaults, mode: 'snapshot' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'snapshot' })
  })

  it('falls back to off for an unsupported saved mode', async () => {
    savePreferences({ ...defaults, mode: 'unexpected' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)
  })

  it('migrates auto-starting preferences to the saved mode', async () => {
    savePreferences({ ...defaults, mode: 'snapshot', autoStart: true }, 1)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'snapshot' })
    expect(usePreviewStore.getState()).not.toHaveProperty('autoStart')
    expect(savedPreferences()).toEqual({ version: 2, state: { ...defaults, mode: 'snapshot' } })

    savePreferences({ ...defaults, mode: 'live', autoStart: true }, 0)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'live' })
  })

  it('clears the saved mode when legacy preferences did not auto-start', async () => {
    savePreferences({ ...defaults, mode: 'live', autoStart: false }, 1)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    savePreferences({ ...defaults, mode: 'live', autoStart: 'true' }, 1)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    savePreferences({ ...defaults, mode: 'live' }, 0)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)
  })

  it('treats preferences without a stored version as the auto-start format', async () => {
    saveUnversionedPreferences({ ...defaults, mode: 'live', autoStart: false })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    saveUnversionedPreferences({ ...defaults, mode: 'snapshot', autoStart: true })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'snapshot' })
  })

  it('restores custom quality and canonicalizes saved presets', async () => {
    savePreferences({ ...defaults, quality: 'custom', fps: 90, maxSize: 1000, bitrateMbps: 2.5 })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({
      quality: 'custom', fps: 90, maxSize: 1000, bitrateMbps: 2.5,
    })

    savePreferences({ quality: 'smooth', fps: 999, maxSize: null, bitrateMbps: 'invalid' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({
      ...defaults,
      quality: 'smooth',
      fps: qualityPresets.smooth.fps,
      maxSize: qualityPresets.smooth.maxSize,
      bitrateMbps: qualityPresets.smooth.bitrateMbps,
    })
  })

  it('sanitizes stale data and does not accept persisted actions', async () => {
    savePreferences({
      mode: 'unexpected', autoStart: 'true', quality: 'custom',
      fps: -10, maxSize: 2.5, bitrateMbps: 9000, setMode: 'overwritten',
    }, 0)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, quality: 'custom' })
    expect(usePreviewStore.getState().setMode).toBeTypeOf('function')

    savePreferences(['live', 'ultra'])
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    savePreferences(['live', 'ultra'], 1)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    savePreferences({ mode: 'live', quality: '__proto__' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'live' })

    savePreferences({ mode: 'live', autoStart: true, quality: '__proto__' }, 1)
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, mode: 'live' })
  })

  it('ignores invalid custom values and malformed JSON', async () => {
    usePreviewStore.getState().setCustomFps(NaN)
    usePreviewStore.getState().setCustomMaxSize(Infinity)
    usePreviewStore.getState().setCustomBitrateMbps(0)
    expect(usePreviewStore.getState()).toMatchObject(defaults)

    window.localStorage.setItem('preview-storage', '{invalid')
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject(defaults)
  })
})
