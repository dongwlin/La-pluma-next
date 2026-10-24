import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { qualityPresets, type QualityPreset, type QualitySelection } from '../constants'

export type PreviewMode = 'off' | 'snapshot' | 'live'

interface PreviewPreferences {
  mode: PreviewMode
  autoStart: boolean
  quality: QualitySelection
  fps: number
  maxSize: number
  bitrateMbps: number
}

interface PreviewState extends PreviewPreferences {
  setMode: (mode: PreviewMode) => void
  setAutoStart: (autoStart: boolean) => void
  setQuality: (quality: QualitySelection) => void
  setCustomFps: (fps: number) => void
  setCustomMaxSize: (maxSize: number) => void
  setCustomBitrateMbps: (bitrateMbps: number) => void
}

const defaultPreferences: PreviewPreferences = {
  mode: 'off',
  autoStart: false,
  quality: 'power',
  fps: qualityPresets.power.fps,
  maxSize: qualityPresets.power.maxSize,
  bitrateMbps: qualityPresets.power.bitrateMbps,
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return value === 'off' || value === 'snapshot' || value === 'live'
}

function isQualityPreset(value: unknown): value is QualityPreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(qualityPresets, value)
}

function isFps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 120
}

function isMaxSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8192
}

function isBitrate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 32
}

function restorePreferences(persisted: unknown): PreviewPreferences {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    return { ...defaultPreferences }
  }

  const stored = persisted as Record<string, unknown>
  const autoStart = stored.autoStart === true
  const quality = stored.quality === 'custom' || isQualityPreset(stored.quality)
    ? stored.quality
    : defaultPreferences.quality
  const preset = quality === 'custom' ? defaultPreferences : qualityPresets[quality]

  return {
    autoStart,
    // Navigation keeps this runtime state; only a new app load applies auto-start.
    mode: autoStart && isPreviewMode(stored.mode) ? stored.mode : 'off',
    quality,
    fps: quality === 'custom' && isFps(stored.fps) ? stored.fps : preset.fps,
    maxSize: quality === 'custom' && isMaxSize(stored.maxSize) ? stored.maxSize : preset.maxSize,
    bitrateMbps: quality === 'custom' && isBitrate(stored.bitrateMbps) ? stored.bitrateMbps : preset.bitrateMbps,
  }
}

export function buildScrcpyOptions({ fps, maxSize, bitrateMbps, quality }: Pick<PreviewPreferences, 'fps' | 'maxSize' | 'bitrateMbps' | 'quality'>) {
  const bitrate = Math.round(bitrateMbps * 1000000)
  const preset = quality === 'custom' ? null : qualityPresets[quality]

  return {
    max_fps: fps,
    max_size: maxSize,
    bitrate,
    min_bitrate: Math.min(bitrate, Math.max(1000000, Math.round(bitrate * 0.35))),
    max_bitrate: Math.round(Math.max(bitrateMbps, preset?.maxBitrateMbps ?? bitrateMbps) * 1000000),
    bwe: true,
    audio: false,
    snapshot_interval: 10,
  }
}

export const usePreviewStore = create<PreviewState>()(
  persist(
    (set) => ({
      ...defaultPreferences,
      setMode: (mode) => set({ mode }),
      setAutoStart: (autoStart) => set({ autoStart }),
      setQuality: (quality) => {
        if (quality === 'custom') {
          set({ quality })
          return
        }
        const { fps, maxSize, bitrateMbps } = qualityPresets[quality]
        set({ quality, fps, maxSize, bitrateMbps })
      },
      setCustomFps: (fps) => {
        if (isFps(fps)) set({ quality: 'custom', fps })
      },
      setCustomMaxSize: (maxSize) => {
        if (isMaxSize(maxSize)) set({ quality: 'custom', maxSize })
      },
      setCustomBitrateMbps: (bitrateMbps) => {
        if (isBitrate(bitrateMbps)) set({ quality: 'custom', bitrateMbps })
      },
    }),
    {
      name: 'preview-storage',
      version: 1,
      partialize: ({ mode, autoStart, quality, fps, maxSize, bitrateMbps }) => ({
        mode, autoStart, quality, fps, maxSize, bitrateMbps,
      }),
      migrate: (persisted) => restorePreferences(persisted),
      merge: (persisted, current) => ({ ...current, ...restorePreferences(persisted) }),
    },
  ),
)
