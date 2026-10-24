/**
 * 投屏/截图预览域常量
 */

export const qualityPresets = {
  power: { label: '省电', fps: 15, maxSize: 640, bitrateMbps: 1.5, maxBitrateMbps: 3 },
  smooth: { label: '流畅', fps: 30, maxSize: 960, bitrateMbps: 4, maxBitrateMbps: 8 },
  balanced: { label: '均衡', fps: 45, maxSize: 1280, bitrateMbps: 8, maxBitrateMbps: 16 },
  crisp: { label: '清晰', fps: 60, maxSize: 1600, bitrateMbps: 14, maxBitrateMbps: 24 },
  ultra: { label: '超清', fps: 60, maxSize: 1920, bitrateMbps: 20, maxBitrateMbps: 32 },
} as const

export const fpsOptions = [10, 15, 30, 45, 60, 90, 120] as const

export type QualityPreset = keyof typeof qualityPresets
export type QualitySelection = QualityPreset | 'custom'
