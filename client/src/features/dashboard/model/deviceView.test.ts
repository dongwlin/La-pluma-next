import { describe, expect, it } from 'vitest'
import { buildTemperatureSeries, getUsageTone } from './deviceView'

describe('getUsageTone', () => {
  it('maps usage thresholds to color semantics', () => {
    expect(getUsageTone(undefined)).toBe('normal')
    expect(getUsageTone(null)).toBe('normal')
    expect(getUsageTone(0)).toBe('normal')
    expect(getUsageTone(74.9)).toBe('normal')
    expect(getUsageTone(75)).toBe('warning')
    expect(getUsageTone(89.9)).toBe('warning')
    expect(getUsageTone(90)).toBe('danger')
    expect(getUsageTone(100)).toBe('danger')
  })
})

describe('buildTemperatureSeries', () => {
  it('returns no series for an empty history', () => {
    expect(buildTemperatureSeries([])).toBeNull()
  })

  it('draws a single sample without dividing by zero', () => {
    const series = buildTemperatureSeries([38])
    expect(series).not.toBeNull()
    expect(series?.min).toBe(38)
    expect(series?.max).toBe(38)
    expect(series?.durationLabel).toBe('近 5 秒')
  })

  it('keeps the sampled min and max for a stable range', () => {
    const series = buildTemperatureSeries([38, 38.05])
    expect(series?.min).toBe(38)
    expect(series?.max).toBe(38.05)
  })

  it('labels the sampled window from the sample spacing', () => {
    expect(buildTemperatureSeries([36, 37, 38])?.durationLabel).toBe('近 10 秒')
    expect(buildTemperatureSeries([36, 37, 38, 39])?.durationLabel).toBe('近 15 秒')
  })
})
