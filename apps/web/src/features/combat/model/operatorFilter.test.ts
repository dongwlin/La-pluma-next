import { describe, expect, it } from 'vitest'
import type { OperBoxCatalogOperator, OperBoxData, OperatorDetailed } from '@/features/game-data'
import {
  buildOperatorFilterOptions,
  filterOperatorOptions,
  normalizeOperatorSelection,
  orderOperatorFilterOptions,
  type OperatorFilterOption,
} from './operatorFilter'

const catalogOperator = (overrides: Partial<OperBoxCatalogOperator>): OperBoxCatalogOperator => ({
  id: 'char_002_amiya',
  name: '阿米娅',
  rarity: 5,
  owned: true,
  ...overrides,
})

const detailedOperator = (overrides: Partial<OperatorDetailed>): OperatorDetailed => ({
  id: 'char_002_amiya',
  name: '阿米娅',
  rarity: 5,
  profession: 'CASTER',
  level: 1,
  elite: 0,
  potential: 1,
  ...overrides,
})

const withCatalog = (
  allOpers: OperBoxCatalogOperator[],
  data: OperatorDetailed[] = [],
): OperBoxData => ({
  operCount: allOpers.filter(operator => operator.owned).length,
  data,
  allOpers,
  timestamp: '2026-01-01T00:00:00.000Z',
})

const options = buildOperatorFilterOptions(withCatalog([
  catalogOperator({ id: 'char_002_amiya', name: '阿米娅', owned: true }),
  catalogOperator({ id: 'char_003_kalts', name: '凯尔希·思衡托', rarity: 6, owned: false }),
  catalogOperator({ id: 'char_017_huang', name: '煌', rarity: 6, owned: true, names: { en: 'Blaze' } }),
]))

const ids = (term: string): string[] => filterOperatorOptions(options, term).map(option => option.id)

describe('buildOperatorFilterOptions', () => {
  it('keeps every catalog entry with its owned flag, rarity and names', () => {
    expect(buildOperatorFilterOptions(withCatalog([
      catalogOperator({}),
      catalogOperator({
        id: 'char_003_kalts',
        name: '凯尔希',
        rarity: 6,
        owned: false,
        names: { en: "Kal'tsit", jp: 'ケルシー' },
      }),
    ]))).toEqual([
      { id: 'char_002_amiya', name: '阿米娅', owned: true, rarity: 5 },
      {
        id: 'char_003_kalts',
        name: '凯尔希',
        owned: false,
        rarity: 6,
        names: { en: "Kal'tsit", jp: 'ケルシー' },
      },
    ])
  })

  it('merges elite and level from the owned snapshot into the catalog', () => {
    expect(buildOperatorFilterOptions(withCatalog([
      catalogOperator({ id: 'char_002_amiya', name: '阿米娅' }),
      catalogOperator({ id: 'char_003_kalts', name: '凯尔希', rarity: 6 }),
      catalogOperator({ id: 'char_017_huang', name: '煌', rarity: 6, owned: false }),
    ], [
      detailedOperator({ id: 'char_003_kalts', name: '凯尔希', rarity: 6, elite: 2, level: 60 }),
      detailedOperator({ id: 'char_002_amiya', name: '阿米娅', elite: 1, level: 40 }),
    ]))).toEqual([
      { id: 'char_002_amiya', name: '阿米娅', owned: true, rarity: 5, elite: 1, level: 40 },
      { id: 'char_003_kalts', name: '凯尔希', owned: true, rarity: 6, elite: 2, level: 60 },
      { id: 'char_017_huang', name: '煌', owned: false, rarity: 6 },
    ])
  })

  it('falls back to the owned operators when the catalog is missing', () => {
    expect(buildOperatorFilterOptions({
      operCount: 1,
      data: [detailedOperator({ level: 50, elite: 2 })],
      timestamp: '2026-01-01T00:00:00.000Z',
    })).toEqual([
      { id: 'char_002_amiya', name: '阿米娅', owned: true, rarity: 5, elite: 2, level: 50 },
    ])
  })

  it('returns an empty list without any operator snapshot', () => {
    expect(buildOperatorFilterOptions(null)).toEqual([])
    expect(buildOperatorFilterOptions({
      operCount: 0,
      data: [],
      allOpers: [],
      timestamp: '2026-01-01T00:00:00.000Z',
    })).toEqual([])
  })
})

describe('filterOperatorOptions', () => {
  it('matches Chinese substrings', () => {
    expect(ids('阿米')).toEqual(['char_002_amiya'])
    expect(ids('凯尔')).toEqual(['char_003_kalts'])
    expect(ids('思衡托')).toEqual(['char_003_kalts'])
  })

  it('matches full pinyin and pinyin initials', () => {
    expect(ids('amiya')).toEqual(['char_002_amiya'])
    expect(ids('amy')).toEqual(['char_002_amiya'])
    expect(ids('kaierxi')).toEqual(['char_003_kalts'])
    expect(ids('kex')).toEqual(['char_003_kalts'])
  })

  it('keeps names with a middle dot searchable across the symbol', () => {
    expect(ids('凯尔希·思衡托')).toEqual(['char_003_kalts'])
    expect(ids('kexsht')).toEqual(['char_003_kalts'])
    expect(ids('kaierxisihengtuo')).toEqual(['char_003_kalts'])
  })

  it('matches English names case-insensitively and ignores spaces', () => {
    expect(ids('blaze')).toEqual(['char_017_huang'])
    expect(ids('BLAZE')).toEqual(['char_017_huang'])
    expect(ids(' b l a z e ')).toEqual(['char_017_huang'])
  })

  it('returns every option for a blank term and keeps unowned entries', () => {
    expect(ids('')).toEqual(['char_002_amiya', 'char_003_kalts', 'char_017_huang'])
    expect(filterOperatorOptions(options, '凯尔')).toEqual([
      { id: 'char_003_kalts', name: '凯尔希·思衡托', owned: false, rarity: 6 },
    ])
  })

  it('indexes options that were not built through the catalog helper', () => {
    const manual = [{ id: 'char_002_amiya', name: '阿米娅', owned: true }]

    expect(filterOperatorOptions(manual, 'amiya')).toEqual(manual)
    expect(filterOperatorOptions(manual, '')).toEqual(manual)
  })
})

describe('orderOperatorFilterOptions', () => {
  const trainedOptions: readonly OperatorFilterOption[] = [
    { id: 'char_owned_untrained', name: '未练', owned: true, rarity: 6 },
    { id: 'char_missing_low', name: '未拥有乙', owned: false, rarity: 4 },
    { id: 'char_owned_mid', name: '中练', owned: true, rarity: 4, elite: 2, level: 30 },
    { id: 'char_owned_high', name: '高练', owned: true, rarity: 5, elite: 2, level: 90 },
    { id: 'char_missing_high', name: '未拥有甲', owned: false, rarity: 6 },
    { id: 'char_owned_low', name: '低练', owned: true, rarity: 6, elite: 1, level: 80 },
  ]

  const idsOf = (options: readonly OperatorFilterOption[]): string[] => options.map(option => option.id)

  it('puts owned operators first and orders included operators by training descending', () => {
    expect(idsOf(orderOperatorFilterOptions(trainedOptions, 'included'))).toEqual([
      'char_owned_high',
      'char_owned_mid',
      'char_owned_low',
      'char_owned_untrained',
      'char_missing_high',
      'char_missing_low',
    ])
  })

  it('puts unowned operators first and orders excluded operators by training ascending', () => {
    expect(idsOf(orderOperatorFilterOptions(trainedOptions, 'excluded'))).toEqual([
      'char_missing_high',
      'char_missing_low',
      'char_owned_low',
      'char_owned_mid',
      'char_owned_high',
      'char_owned_untrained',
    ])
  })

  it('breaks training ties by rarity, localized name and id', () => {
    const tied: readonly OperatorFilterOption[] = [
      { id: 'char_zzz', name: '同名', owned: true, rarity: 6, elite: 1, level: 1 },
      { id: 'char_b', name: '丙', owned: true, rarity: 6, elite: 1, level: 1 },
      { id: 'char_a', name: '阿', owned: true, rarity: 6, elite: 1, level: 1 },
      { id: 'char_aaa', name: '同名', owned: true, rarity: 6, elite: 1, level: 1 },
      { id: 'char_c', name: '乙', owned: true, rarity: 5, elite: 1, level: 1 },
    ]

    expect(idsOf(orderOperatorFilterOptions(tied, 'included'))).toEqual([
      'char_a',
      'char_b',
      'char_aaa',
      'char_zzz',
      'char_c',
    ])
    expect(idsOf(orderOperatorFilterOptions(tied, 'excluded'))).toEqual([
      'char_a',
      'char_b',
      'char_aaa',
      'char_zzz',
      'char_c',
    ])
  })

  it('returns a new deterministic array without mutating the input', () => {
    const input = [...trainedOptions]
    const first = orderOperatorFilterOptions(input, 'included')
    const second = orderOperatorFilterOptions(input, 'included')

    expect(idsOf(input)).toEqual([
      'char_owned_untrained',
      'char_missing_low',
      'char_owned_mid',
      'char_owned_high',
      'char_missing_high',
      'char_owned_low',
    ])
    expect(idsOf(first)).toEqual(idsOf(second))
    expect(first).not.toBe(input)
  })
})

describe('normalizeOperatorSelection', () => {
  it('trims and dedupes both sets, keeping included when a name appears twice', () => {
    expect(normalizeOperatorSelection({
      included: [' 阿米娅 ', '阿米娅', '凯尔希'],
      excluded: ['阿米娅', '桃金娘', ' 桃金娘 '],
    })).toEqual({
      included: ['阿米娅', '凯尔希'],
      excluded: ['桃金娘'],
    })
  })

  it('drops blank names', () => {
    expect(normalizeOperatorSelection({
      included: ['', '   '],
      excluded: [' ', ''],
    })).toEqual({ included: [], excluded: [] })
  })
})
