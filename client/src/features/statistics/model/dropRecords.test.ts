import { describe, expect, it } from 'vitest'
import {
  DROP_ITEM_DISPLAY_LIMIT,
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

  it('keeps the server key order when counts tie', () => {
    const entries = sortDropItems({
      第一个: { count: 3 },
      第二个: { count: 3 },
    })

    expect(entries.map(entry => entry.name)).toEqual(['第一个', '第二个'])
  })

  it('returns no entries for an empty record', () => {
    expect(sortDropItems({})).toEqual([])
  })

  it('keeps the display limit at twenty materials', () => {
    expect(DROP_ITEM_DISPLAY_LIMIT).toBe(20)
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

  it('keeps the server key order when battle counts tie', () => {
    const entries = sortDropStages({
      '1-7': { battles: 3, sanity: 18, items: {} },
      '1-8': { battles: 3, sanity: 21, items: {} },
    })

    expect(entries.map(entry => entry.name)).toEqual(['1-7', '1-8'])
  })
})
