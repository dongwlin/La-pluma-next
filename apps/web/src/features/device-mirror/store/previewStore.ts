import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { qualityPresets, type QualityPreset, type QualitySelection } from '../constants'

export type PreviewMode = 'off' | 'snapshot' | 'live'

interface PreviewPreferences {
  mode: PreviewMode
  quality: QualitySelection
  fps: number
  maxSize: number
  bitrateMbps: number
}

interface PreviewState extends PreviewPreferences {
  setMode: (mode: PreviewMode) => void
  setQuality: (quality: QualitySelection) => void
  setCustomFps: (fps: number) => void
  setCustomMaxSize: (maxSize: number) => void
  setCustomBitrateMbps: (bitrateMbps: number) => void
}

const PREVIEW_STORAGE_KEY = 'preview-storage'
const PREVIEW_STORAGE_VERSION = 2

const defaultPreferences: PreviewPreferences = {
  mode: 'off',
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

function restorePreferences(persisted: unknown, modeRequiresAutoStart: boolean): PreviewPreferences {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    return { ...defaultPreferences }
  }

  const stored = persisted as Record<string, unknown>
  const quality = stored.quality === 'custom' || isQualityPreset(stored.quality)
    ? stored.quality
    : defaultPreferences.quality
  const preset = quality === 'custom' ? defaultPreferences : qualityPresets[quality]
  const savedMode = isPreviewMode(stored.mode) ? stored.mode : 'off'
  const mode = modeRequiresAutoStart && stored.autoStart !== true ? 'off' : savedMode

  return {
    mode,
    quality,
    fps: quality === 'custom' && isFps(stored.fps) ? stored.fps : preset.fps,
    maxSize: quality === 'custom' && isMaxSize(stored.maxSize) ? stored.maxSize : preset.maxSize,
    bitrateMbps: quality === 'custom' && isBitrate(stored.bitrateMbps) ? stored.bitrateMbps : preset.bitrateMbps,
  }
}

function hasLegacyAutoStart(persisted: unknown): boolean {
  return !!persisted && typeof persisted === 'object' && Object.prototype.hasOwnProperty.call(persisted, 'autoStart')
}

/** 多标签页只在刷新后收敛：写入按本次动作涉及的字段合并最新落盘值（issue #133）。 */
let pendingPreferenceKeys: string[] | null = null

function readStorageItem(name: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(name)
  } catch {
    // 隐私模式或存储被策略拦截时按不可用处理。
    return null
  }
}

function writeStorageItem(name: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(name, value)
  } catch {
    // 存储不可用时只保留内存中的偏好，偏好动作本身不能失败。
  }
}

function removeStorageItem(name: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(name)
  } catch {
    // 存储不可用时无需清理。
  }
}

function readPersistedPreferences(): PreviewPreferences | null {
  const raw = readStorageItem(PREVIEW_STORAGE_KEY)
  if (!raw) return null
  try {
    const envelope: unknown = JSON.parse(raw)
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
    const { state, version } = envelope as { state?: unknown; version?: unknown }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null
    const legacy = typeof version === 'number' ? version < PREVIEW_STORAGE_VERSION : true
    return restorePreferences(state, legacy || hasLegacyAutoStart(state))
  } catch {
    return null
  }
}

function mergePersistedPreferences(next: unknown, changedKeys: string[] | null): PreviewPreferences {
  const latest = readPersistedPreferences()
  if (!latest) return restorePreferences(next, false)

  const nextRecord = next && typeof next === 'object' && !Array.isArray(next)
    ? next as Record<string, unknown>
    : {}
  const merged: Record<string, unknown> = { ...latest }
  for (const key of changedKeys ?? Object.keys(nextRecord)) {
    if (Object.prototype.hasOwnProperty.call(nextRecord, key)) merged[key] = nextRecord[key]
  }
  return restorePreferences(merged, false)
}

const previewStorage: StateStorage = {
  getItem: (name) => readStorageItem(name),
  setItem: (name, value) => {
    try {
      const envelope: unknown = JSON.parse(value)
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        writeStorageItem(name, value)
        return
      }
      const { state, ...rest } = envelope as { state?: unknown }
      const merged = mergePersistedPreferences(state, pendingPreferenceKeys)
      writeStorageItem(name, JSON.stringify({ ...rest, state: merged }))
    } catch {
      writeStorageItem(name, value)
    }
  },
  removeItem: (name) => removeStorageItem(name),
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
    (set) => {
      const commit = (partial: Partial<PreviewPreferences>) => {
        pendingPreferenceKeys = Object.keys(partial)
        try {
          set(partial)
        } finally {
          pendingPreferenceKeys = null
        }
      }

      return {
        ...defaultPreferences,
        setMode: (mode) => commit({ mode }),
        setQuality: (quality) => {
          if (quality === 'custom') {
            commit({ quality })
            return
          }
          const { fps, maxSize, bitrateMbps } = qualityPresets[quality]
          commit({ quality, fps, maxSize, bitrateMbps })
        },
        setCustomFps: (fps) => {
          if (isFps(fps)) commit({ quality: 'custom', fps })
        },
        setCustomMaxSize: (maxSize) => {
          if (isMaxSize(maxSize)) commit({ quality: 'custom', maxSize })
        },
        setCustomBitrateMbps: (bitrateMbps) => {
          if (isBitrate(bitrateMbps)) commit({ quality: 'custom', bitrateMbps })
        },
      }
    },
    {
      name: PREVIEW_STORAGE_KEY,
      storage: createJSONStorage(() => previewStorage),
      version: PREVIEW_STORAGE_VERSION,
      partialize: ({ mode, quality, fps, maxSize, bitrateMbps }) => ({
        mode, quality, fps, maxSize, bitrateMbps,
      }),
      migrate: (persistedState, version) => restorePreferences(persistedState, version < PREVIEW_STORAGE_VERSION),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...restorePreferences(persistedState, hasLegacyAutoStart(persistedState)),
      }),
    },
  ),
)
