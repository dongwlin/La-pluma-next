import { describe, expect, it } from 'vitest'
import type { DepotDataDetailed, DepotItem } from '@/features/game-data'
import {
  getDepotTypeLabel,
  summarizeDepot,
  summarizeDepotTypes,
} from './depotSummary'

const item = (
  id: string,
  name: string,
  count: number,
  classifyType = 'MATERIAL',
): DepotItem => ({ id, name, iconId: `${id}-icon`, count, classifyType })

const depot = (items: DepotItem[], itemCount = items.length): DepotDataDetailed => ({
  itemCount,
  items,
  timestamp: '2026-10-25T08:00:00.000Z',
})

describe('depot type labels', () => {
  it('maps known classifications, unknown ones and missing values', () => {
    expect(getDepotTypeLabel('MATERIAL')).toBe('材料')
    expect(getDepotTypeLabel('FURN')).toBe('家具')
    expect(getDepotTypeLabel('SOMETHING_NEW')).toBe('其他')
    expect(getDepotTypeLabel('')).toBe('未分类')
    expect(getDepotTypeLabel(undefined)).toBe('未分类')
  })
})

describe('depot type grouping', () => {
  it('sums counts and kinds per classification, largest first', () => {
    const groups = summarizeDepotTypes([
      item('a', '固源岩', 10, 'MATERIAL'),
      item('b', '装置', 5, 'MATERIAL'),
      item('c', '经验书', 30, 'CARD_EXP'),
      item('d', '家具', 3, 'FURN'),
      item('e', '无分类物品', 2, ''),
    ])

    expect(groups).toEqual([
      { type: 'CARD_EXP', label: '经验书', kinds: 1, count: 30 },
      { type: 'MATERIAL', label: '材料', kinds: 2, count: 15 },
      { type: 'FURN', label: '家具', kinds: 1, count: 3 },
      { type: 'UNKNOWN', label: '其他', kinds: 1, count: 2 },
    ])
  })

  it('keeps the first-seen order when counts tie', () => {
    const groups = summarizeDepotTypes([
      item('a', '装置', 4, 'CONSUME'),
      item('b', '固源岩', 4, 'MATERIAL'),
    ])

    expect(groups.map(group => group.type)).toEqual(['CONSUME', 'MATERIAL'])
  })

  it('returns no groups for an empty list', () => {
    expect(summarizeDepotTypes([])).toEqual([])
  })
})

describe('depot overview', () => {
  it('reports the server item count, material kinds, totals and the largest stack', () => {
    const overview = summarizeDepot(depot([
      item('a', '固源岩', 10),
      item('b', '装置', 5),
      item('c', '经验书', 30, 'CARD_EXP'),
      item('d', '赤金', 30, 'CONSUME'),
    ], 4))

    expect(overview.itemCount).toBe(4)
    expect(overview.materialKinds).toBe(2)
    expect(overview.categoryCount).toBe(3)
    expect(overview.totalCount).toBe(75)
    expect(overview.topItem?.name).toBe('经验书')
    expect(overview.groups.map(group => group.type)).toEqual(['CARD_EXP', 'CONSUME', 'MATERIAL'])
  })

  it('keeps the first item when the largest stacks tie', () => {
    const overview = summarizeDepot(depot([item('a', '第一个', 12), item('b', '第二个', 12)]))

    expect(overview.topItem?.name).toBe('第一个')
  })

  it('returns empty totals for a missing snapshot', () => {
    expect(summarizeDepot(null)).toEqual({
      groups: [],
      itemCount: 0,
      materialKinds: 0,
      categoryCount: 0,
      totalCount: 0,
      topItem: null,
    })
  })
})
