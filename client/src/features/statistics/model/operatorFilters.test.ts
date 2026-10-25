import { describe, expect, it } from 'vitest'
import type { OperBoxData, OperatorDetailed } from '@/features/game-data'
import {
  AMIYA_FORM_IDS,
  DEFAULT_OPERATOR_FILTERS,
  buildOwnedOperatorIdSet,
  hasActiveOperatorFilters,
  isOwnedOperator,
  selectOperators,
  type OperatorFilters,
} from './operatorFilters'

const operator = (
  id: string,
  name: string,
  overrides: Partial<OperatorDetailed> = {},
): OperatorDetailed => ({
  id,
  name,
  rarity: 4,
  profession: 'SNIPER',
  level: 0,
  elite: 0,
  potential: 1,
  ...overrides,
})

const catalog: OperatorDetailed[] = [
  operator('char_002_amiya', '阿米娅', { rarity: 5, profession: 'CASTER' }),
  operator('char_1001_amiya2', '阿米娅', { rarity: 5, profession: 'CASTER' }),
  operator('char_1037_amiya3', '阿米娅', { rarity: 5, profession: 'CASTER' }),
  operator('char_alpha', '阿尔法', { rarity: 6 }),
  operator('char_beta', '贝塔', { rarity: 4, profession: 'MEDIC' }),
  operator('char_gamma', '伽马', { rarity: 4 }),
]

const operBox = (data: OperatorDetailed[]): OperBoxData => ({
  operCount: data.length,
  data,
  timestamp: '2026-10-25T00:00:00.000Z',
})

const ownedBox = operBox([
  operator('char_alpha', '阿尔法', { rarity: 6, level: 80, elite: 2, potential: 1 }),
  operator('char_002_amiya', '阿米娅', { rarity: 5, profession: 'CASTER', level: 50, elite: 2, potential: 3 }),
])

const filters = (overrides: Partial<OperatorFilters> = {}): OperatorFilters => ({
  ...DEFAULT_OPERATOR_FILTERS,
  ...overrides,
})

const ids = (operators: readonly OperatorDetailed[]) => operators.map(op => op.id)

describe('Amiya form ownership', () => {
  it('expands all three forms when any one is owned', () => {
    const ownedIds = buildOwnedOperatorIdSet(ownedBox)

    expect(AMIYA_FORM_IDS.every(id => ownedIds.has(id))).toBe(true)
    expect(ownedIds.size).toBe(4)
  })

  it('does not invent forms when no Amiya form is owned', () => {
    const ownedIds = buildOwnedOperatorIdSet(operBox([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    expect(AMIYA_FORM_IDS.some(id => ownedIds.has(id))).toBe(false)
    expect(ownedIds.size).toBe(1)
  })

  it('treats every form as owned on the operator card', () => {
    const ownedIds = buildOwnedOperatorIdSet(ownedBox)
    const unownedForm = catalog.find(op => op.id === 'char_1037_amiya3')!

    expect(isOwnedOperator(unownedForm, ownedIds)).toBe(true)
    expect(isOwnedOperator(catalog.find(op => op.id === 'char_beta')!, ownedIds)).toBe(false)
  })
})

describe('operator selection', () => {
  it('excludes every Amiya form from the unowned view', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'unowned' }),
    })

    expect(ids(result)).not.toContain('char_002_amiya')
    expect(ids(result)).not.toContain('char_1001_amiya2')
    expect(ids(result)).not.toContain('char_1037_amiya3')
    expect(ids(result)).toEqual(['char_beta', 'char_gamma'])
    expect(result.every(op => op.level === 0 && op.elite === 0 && op.potential === 0)).toBe(true)
  })

  it('fills missing Amiya forms from the owned form in the owned view', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', sortBy: 'level' }),
    })

    expect(ids(result)).toHaveLength(4)
    expect(ids(result).slice(1).sort()).toEqual([...AMIYA_FORM_IDS].sort())
    for (const id of AMIYA_FORM_IDS) {
      const form = result.find(op => op.id === id)!
      expect(form).toMatchObject({ level: 50, elite: 2, potential: 3, profession: 'CASTER' })
    }
  })

  it('uses catalog metadata for owned operators and zero stats for the rest in the all view', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'all', profession: 'SNIPER' }),
    })

    expect(ids(result)).toEqual(['char_alpha', 'char_gamma'].sort())
    expect(result.find(op => op.id === 'char_alpha')).toMatchObject({ level: 80, profession: 'SNIPER' })
    expect(result.find(op => op.id === 'char_gamma')).toMatchObject({ level: 0, elite: 0, potential: 0 })
  })

  it('fills missing Amiya forms with owned stats in the all view', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'all', profession: 'CASTER' }),
    })

    expect(ids(result).sort()).toEqual([...AMIYA_FORM_IDS].sort())
    expect(result.every(op => op.level === 50 && op.elite === 2 && op.potential === 3)).toBe(true)
  })

  it('returns an empty list when the required source is absent', () => {
    expect(selectOperators({
      catalog,
      operBox: null,
      filters: filters({ ownership: 'owned' }),
    })).toEqual([])
    expect(selectOperators({
      catalog: [],
      operBox: ownedBox,
      filters: filters(),
    })).toEqual([])
  })
})

describe('operator filters', () => {
  it('clamps rarity above six before comparing', () => {
    const result = selectOperators({
      catalog: [
        operator('char_six', '六星', { rarity: 6 }),
        operator('char_over', '超限', { rarity: 8 }),
        operator('char_five', '五星', { rarity: 5 }),
      ],
      operBox: null,
      filters: filters({ rarity: '6' }),
    })

    expect(ids(result)).toEqual(['char_over', 'char_six'])
  })

  it('ignores elite and potential filters in the unowned view', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'unowned', elite: '2', potential: '3' }),
    })

    expect(ids(result)).toEqual(['char_beta', 'char_gamma'])
  })

  it('applies elite and potential filters outside the unowned view', () => {
    const elite = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', elite: '2' }),
    })
    const potential = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', potential: '1' }),
    })

    expect(elite).toHaveLength(4)
    expect(ids(potential)).toEqual(['char_alpha'])

    const allElite = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'all', elite: '2' }),
    })
    expect(ids(allElite).sort()).toEqual(
      ['char_002_amiya', 'char_1001_amiya2', 'char_1037_amiya3', 'char_alpha'].sort(),
    )
  })
})

describe('operator sorting', () => {
  it('keeps the owned snapshot order for the default sort', () => {
    const result = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned' }),
    })

    expect(ids(result)).toEqual([
      'char_alpha',
      'char_002_amiya',
      'char_1001_amiya2',
      'char_1037_amiya3',
    ])
  })

  it('sorts owned operators by level, rarity, or potential', () => {
    const byLevel = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', sortBy: 'level' }),
    })
    const byRarity = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', sortBy: 'rarity' }),
    })
    const byPotential = selectOperators({
      catalog,
      operBox: ownedBox,
      filters: filters({ ownership: 'owned', sortBy: 'potential' }),
    })

    expect(byLevel[0]?.id).toBe('char_alpha')
    expect(byRarity[0]?.id).toBe('char_alpha')
    expect(byPotential[0]?.id).toBe('char_002_amiya')
  })

  it('sorts non-owned views by rarity then Chinese name and ignores level sorting', () => {
    const result = selectOperators({
      catalog: [
        operator('char_low', '阿低', { rarity: 3 }),
        operator('char_high_b', '乙高', { rarity: 5 }),
        operator('char_high_a', '甲高', { rarity: 5 }),
      ],
      operBox: null,
      filters: filters({ ownership: 'unowned', sortBy: 'level' }),
    })

    expect(ids(result)).toEqual(['char_high_a', 'char_high_b', 'char_low'])
  })

  it('does not sort the caller-owned catalog array in place', () => {
    const unsorted = [
      operator('char_low', '阿低', { rarity: 3 }),
      operator('char_high', '阿高', { rarity: 6 }),
    ]
    const before = ids(unsorted)

    selectOperators({ catalog: unsorted, operBox: null, filters: filters() })

    expect(ids(unsorted)).toEqual(before)
  })
})

describe('filter activity', () => {
  it('detects active filters and resets to the default state', () => {
    expect(hasActiveOperatorFilters(DEFAULT_OPERATOR_FILTERS)).toBe(false)
    expect(hasActiveOperatorFilters(filters({ sortBy: 'rarity' }))).toBe(true)
    expect(hasActiveOperatorFilters(filters({ ownership: 'owned' }))).toBe(true)
  })
})
