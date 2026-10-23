// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { buildScrcpyOptions, fpsOptions, qualityPresets, usePreviewStore } from './previewStore'

const defaults = {
  mode: 'off' as const,
  autoStart: false,
  quality: 'power' as const,
  fps: 15,
  maxSize: 640,
  bitrateMbps: 1.5,
}

function savePreferences(state: unknown, version = 1) {
  window.localStorage.setItem('preview-storage', JSON.stringify({ state, version }))
}

describe('shared preview preferences', () => {
  beforeEach(() => {
    usePreviewStore.setState(defaults)
    window.localStorage.clear()
  })

  it('starts stopped with the power preset and offers low frame rates', () => {
    expect(usePreviewStore.getState()).toMatchObject(defaults)
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

  it('preserves the active mode in this session while saving only preferences', () => {
    usePreviewStore.getState().setMode('live')
    usePreviewStore.getState().setQuality('ultra')
    expect(usePreviewStore.getState().mode).toBe('live')
    expect(JSON.parse(window.localStorage.getItem('preview-storage') ?? '{}')).toEqual({
      version: 1,
      state: { ...defaults, mode: 'live', quality: 'ultra', fps: 60, maxSize: 1920, bitrateMbps: 20 },
    })
  })

  it('requires auto-start to restore the saved mode after loading', async () => {
    savePreferences({ ...defaults, mode: 'live', autoStart: false })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState().mode).toBe('off')

    savePreferences({ ...defaults, mode: 'snapshot', autoStart: true })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ mode: 'snapshot', autoStart: true })

    savePreferences({ ...defaults, mode: 'live', autoStart: true })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState().mode).toBe('live')
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

    savePreferences({ mode: 'live', autoStart: true, quality: '__proto__' })
    await usePreviewStore.persist.rehydrate()
    expect(usePreviewStore.getState()).toMatchObject({ ...defaults, autoStart: true, mode: 'live' })
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
