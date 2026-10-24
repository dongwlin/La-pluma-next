import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 视觉基线会冻结动画，删掉 keyframes 不会让截图报错；这里守住源码层。
const globalStyles = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

const PAGE_KEYFRAMES = [
  'app-skeleton-sweep',
  'automation-progress-spin',
  'app-status-beam-orbit',
  'app-status-beam-breathe',
  'preview-status-pulse',
  'app-activity-indicator-spin',
] as const

describe('global styles', () => {
  it('keeps every page keyframe used by the UI', () => {
    for (const name of PAGE_KEYFRAMES) {
      expect(globalStyles).toContain(`@keyframes ${name}`)
    }
  })
})
