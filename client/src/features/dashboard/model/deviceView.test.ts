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

  it('draws one sample as a flat line between two identical points', () => {
    const series = buildTemperatureSeries([38])
    expect(series).not.toBeNull()
    expect(series?.min).toBe(38)
    expect(series?.max).toBe(38)
    expect(series?.points).toBe('0.00,16.00 100.00,16.00')
    expect(series?.areaPoints).toBe('0,28 0.00,16.00 100.00,16.00 100,28')
    expect(series?.lastPoint).toEqual(['100.00', '16.00'])
    expect(series?.durationLabel).toBe('近 5 秒')
  })

  it('normalizes a stable range without dividing by zero', () => {
    const series = buildTemperatureSeries([38, 38.05])
    expect(series?.min).toBe(38)
    expect(series?.max).toBe(38.05)
    expect(series?.points).toBe('0.00,16.22 100.00,15.78')
  })

  it('maps a varying history to the 0–28 view box and keeps the sample spacing', () => {
    const series = buildTemperatureSeries([30, 40, 35])
    expect(series?.min).toBe(30)
    expect(series?.max).toBe(40)
    expect(series?.points).toBe('0.00,25.00 50.00,7.00 100.00,16.00')
    expect(series?.areaPoints).toBe('0,28 0.00,25.00 50.00,7.00 100.00,16.00 100,28')
    expect(series?.lastPoint).toEqual(['100.00', '16.00'])
    expect(series?.durationLabel).toBe('近 10 秒')
  })

  it('never reports a duration shorter than one polling interval', () => {
    expect(buildTemperatureSeries([36, 37, 38, 39])?.durationLabel).toBe('近 15 秒')
  })
})
