import { describe, expect, it } from 'vitest'
import { readStatisticsTab, statisticsTabRoute } from './tabNavigation'

describe('statistics tab navigation', () => {
  it('builds a route for every statistics tab and keeps the default one short', () => {
    expect(statisticsTabRoute('operbox')).toBe('/app/statistics')
    expect(statisticsTabRoute('depot')).toBe('/app/statistics?tab=depot')
    expect(statisticsTabRoute('drops')).toBe('/app/statistics?tab=drops')
  })

  it('accepts every known tab id', () => {
    for (const tab of ['operbox', 'depot', 'drops'] as const) {
      expect(readStatisticsTab(tab)).toBe(tab)
    }
  })

  it('ignores missing, malformed and unknown tab values', () => {
    expect(readStatisticsTab(undefined)).toBeNull()
    expect(readStatisticsTab(null)).toBeNull()
    expect(readStatisticsTab('')).toBeNull()
    expect(readStatisticsTab('logs')).toBeNull()
    expect(readStatisticsTab(1)).toBeNull()
  })
})
