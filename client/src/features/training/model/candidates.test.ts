import { describe, expect, it } from 'vitest'
import type { OperatorDetailed } from '@/features/game-data'
import { buildAllCandidateRows, extractOperatorRows } from './candidates'
import {
  EMPTY_TRAINING_COUNTS,
  buildTrainingStatusCounts,
  countOperatorsByCurrentMetaFilters,
  mergeTrainingStatusCounts,
} from './statusCounts'

const catalogOperator = (
  id: string,
  name: string,
  rarity: number,
  overrides: Partial<OperatorDetailed> = {},
): OperatorDetailed => ({
  id,
  name,
  rarity,
  profession: 'SNIPER',
  level: 0,
  elite: 0,
  potential: 0,
  ...overrides,
})

describe('training candidate extraction', () => {
  it('accepts the operators envelope, a top-level array, and the legacy data envelope', () => {
    const row = { id: 'char_1', name: '干员一' }

    expect(extractOperatorRows({ operators: [row] })).toEqual([row])
    expect(extractOperatorRows([row])).toEqual([row])
    expect(extractOperatorRows({ data: [row] })).toEqual([row])
    expect(extractOperatorRows(null)).toEqual([])
    expect(extractOperatorRows({ operators: 'not-an-array' })).toEqual([])
  })
})

describe('all candidate fallback', () => {
  it('rebuilds owned and unowned rows from the catalog and operbox snapshot', () => {
    const catalog = [
      catalogOperator('char_owned', '目录名', 6),
      catalogOperator('char_unowned', '未拥有', 5),
    ]
    const owned = [
      catalogOperator('char_owned', '识别名', 6, { elite: 1, level: 80 }),
    ]

    expect(buildAllCandidateRows(catalog, owned, null)).toEqual([
      {
        id: 'char_owned',
        name: '识别名',
        rarity: 6,
        profession: 'SNIPER',
        currentElite: 1,
        currentLevel: 80,
        targetElite: 2,
        owned: true,
        hasMaterialData: false,
        canTrain: false,
        disabledReason: 'missing_material_data',
        trainingStatus: 'missing_material_data',
      },
      {
        id: 'char_unowned',
        name: '未拥有',
        rarity: 5,
        profession: 'SNIPER',
        currentElite: 0,
        currentLevel: 0,
        targetElite: 2,
        owned: false,
        hasMaterialData: false,
        canTrain: false,
        disabledReason: 'unowned',
        trainingStatus: 'unowned',
      },
    ])
  })

  it('filters the rebuilt catalogue by rarity only', () => {
    const catalog = [
      catalogOperator('char_6', '六星', 6, { elite: 2 }),
      catalogOperator('char_5', '五星', 5),
    ]

    expect(buildAllCandidateRows(catalog, [], 5).map(operator => operator.id)).toEqual(['char_5'])
  })

  it('keeps the endpoint rows untouched when status=all already returned data', () => {
    const rows = [{ id: 'char_1', name: '干员一', rarity: 6, profession: 'SNIPER', currentElite: 1, targetElite: 2, canTrain: true }]
    expect(extractOperatorRows({ operators: rows })).toEqual(rows)
  })
})

describe('training status counts', () => {
  it('counts by rarity and elite using both currentElite and legacy elite fields', () => {
    const rows = [
      { rarity: 6, currentElite: 1 },
      { rarity: 6, elite: 2 },
      { rarity: 5, currentElite: 0 },
    ]

    expect(countOperatorsByCurrentMetaFilters(rows, {})).toBe(3)
    expect(countOperatorsByCurrentMetaFilters(rows, { rarity: 6 })).toBe(2)
    expect(countOperatorsByCurrentMetaFilters(rows, { rarity: 6, needsElite2: true })).toBe(1)
  })

  it('uses the owned endpoint first and falls back to the operbox snapshot', () => {
    const filters = { rarity: 6, needsElite2: true }
    const counts = buildTrainingStatusCounts({
      trainableRows: [{ rarity: 6, currentElite: 0 }],
      ownedRows: [],
      catalog: [{ rarity: 6 }, { rarity: 6 }, { rarity: 5 }],
      operBoxRows: [{ rarity: 6, elite: 1 }, { rarity: 6, elite: 2 }],
      filters,
    })

    expect(counts).toEqual({ trainable: 1, owned: 1, all: 2 })

    const withOwnedRows = buildTrainingStatusCounts({
      trainableRows: [],
      ownedRows: [{ rarity: 6 }, { rarity: 6 }],
      catalog: [],
      operBoxRows: [{ rarity: 6 }],
      filters,
    })
    expect(withOwnedRows.owned).toBe(2)
  })

  it('does not apply the elite condition to the all count', () => {
    const counts = buildTrainingStatusCounts({
      trainableRows: [],
      ownedRows: [],
      catalog: [{ rarity: 6, elite: 2 }],
      operBoxRows: [],
      filters: { rarity: 6, needsElite2: true },
    })

    expect(counts.all).toBe(1)
  })

  it('keeps the previous all count when the refreshed catalogue count is zero', () => {
    const previous = { trainable: 3, owned: 2, all: 12 }

    expect(mergeTrainingStatusCounts(previous, { ...previous })).toBe(previous)
    expect(mergeTrainingStatusCounts(previous, { trainable: 4, owned: 2, all: 0 })).toEqual({
      trainable: 4,
      owned: 2,
      all: 12,
    })
    expect(mergeTrainingStatusCounts(previous, { trainable: 4, owned: 2, all: 9 })).toEqual({
      trainable: 4,
      owned: 2,
      all: 9,
    })
    expect(mergeTrainingStatusCounts(undefined, { trainable: 1, owned: 0, all: 0 })).toEqual({
      trainable: 1,
      owned: 0,
      all: 0,
    })
  })

  it('starts from a zero count identity shared by the page fallback', () => {
    expect(EMPTY_TRAINING_COUNTS).toEqual({ trainable: 0, owned: 0, all: 0 })
  })
})
