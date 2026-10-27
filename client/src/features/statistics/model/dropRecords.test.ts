import { describe, expect, it } from 'vitest'
import {
  sortDropItems,
  sortDropStages,
} from './dropRecords'

describe('drop item ordering', () => {
  it('sorts materials by count without losing their icon identity', () => {
    const entries = sortDropItems({
      固源岩: { count: 6, iconId: 'rock' },
      装置: { count: 12, iconId: 'device' },
      无图标材料: { count: 9 },
    })

    expect(entries).toEqual([
      { name: '装置', count: 12, iconId: 'device' },
      { name: '无图标材料', count: 9 },
      { name: '固源岩', count: 6, iconId: 'rock' },
    ])
  })
})

describe('drop stage ordering', () => {
  it('sorts stages by battle count and keeps sanity and item drops', () => {
    const entries = sortDropStages({
      '1-7': { battles: 3, sanity: 18, items: { 固源岩: 6 } },
      'AP-5': { battles: 8, sanity: 120, items: {} },
    })

    expect(entries).toEqual([
      { name: 'AP-5', battles: 8, sanity: 120, items: {} },
      { name: '1-7', battles: 3, sanity: 18, items: { 固源岩: 6 } },
    ])
  })
})
