import { describe, expect, it } from 'vitest'
import type { OperatorDetailed } from '@/features/game-data'
import type { OperatorPickerOption } from '../types'
import {
  OPERATOR_PROFESSION_FILTERS,
  filterOperatorOptionsByProfession,
  sortOperatorPickerOptions,
  toOperatorPickerOption,
} from './operatorSelection'

const detailed = (
  id: string,
  name: string,
  fields: Partial<Omit<OperatorDetailed, 'id' | 'name'>> = {},
): OperatorDetailed => ({
  id,
  name,
  rarity: 6,
  profession: 'CASTER',
  level: 1,
  elite: 0,
  potential: 1,
  ...fields,
})

const option = (
  id: string,
  name: string,
  fields: Partial<Omit<OperatorPickerOption, 'id' | 'name'>> = {},
): OperatorPickerOption => ({ id, name, rarity: 6, ...fields })

describe('operator picker selection model', () => {
  it('fills the profession from the catalog entry while keeping the recognized elite and level', () => {
    const owned = detailed('char_002_amiya', '阿米娅', { profession: '', rarity: 5, elite: 1, level: 70 })

    const merged = toOperatorPickerOption(owned, detailed('char_002_amiya', '阿米娅', { profession: 'CASTER' }))

    expect(merged).toEqual({
      id: 'char_002_amiya',
      name: '阿米娅',
      rarity: 5,
      profession: 'CASTER',
      elite: 1,
      level: 70,
    })
  })

  it('prefers the profession carried by the source row and omits fields the row does not have', () => {
    expect(toOperatorPickerOption(
      detailed('char_010_chen', '陈', { profession: 'WARRIOR' }),
      detailed('char_010_chen', '陈', { profession: 'CASTER' }),
    )).toMatchObject({ profession: 'WARRIOR' })

    const catalogOnly = toOperatorPickerOption({
      id: 'char_010_chen',
      name: '陈',
      rarity: 6,
    } as OperatorDetailed)
    expect(catalogOnly).toEqual({ id: 'char_010_chen', name: '陈', rarity: 6 })
  })

  it('lists 全部 plus the eight catalog professions in a stable order', () => {
    expect(OPERATOR_PROFESSION_FILTERS.map(entry => entry.label)).toEqual([
      '全部', '先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种',
    ])
  })

  it('filters by profession and keeps every row for 全部', () => {
    const options = [
      option('char_a', '阿米娅', { profession: 'CASTER' }),
      option('char_b', '陈', { profession: 'WARRIOR' }),
      option('char_c', '塞雷娅', { profession: 'TANK' }),
    ]

    expect(filterOperatorOptionsByProfession(options, 'all')).toEqual(options)
    expect(filterOperatorOptionsByProfession(options, 'all')).not.toBe(options)
    expect(filterOperatorOptionsByProfession(options, 'WARRIOR').map(item => item.id)).toEqual(['char_b'])
    expect(filterOperatorOptionsByProfession(options, 'MEDIC')).toEqual([])
  })

  it('sorts ascending by elite then level', () => {
    const options = [
      option('char_a', '阿米娅', { elite: 2, level: 90 }),
      option('char_b', '陈', { elite: 0, level: 60 }),
      option('char_c', '塞雷娅', { elite: 1, level: 80 }),
      option('char_d', '艾雅法拉', { elite: 1, level: 70 }),
    ]

    expect(sortOperatorPickerOptions(options, 'asc').map(item => item.name)).toEqual([
      '陈', '艾雅法拉', '塞雷娅', '阿米娅',
    ])
  })

  it('sorts descending by elite then level for the roguelike picker', () => {
    const options = [
      option('char_a', '阿米娅', { elite: 1, level: 70 }),
      option('char_b', '陈', { elite: 2, level: 90 }),
      option('char_c', '塞雷娅', { elite: 0, level: 60 }),
      option('char_d', '艾雅法拉', { elite: 1, level: 80 }),
    ]

    expect(sortOperatorPickerOptions(options, 'desc').map(item => item.name)).toEqual([
      '陈', '艾雅法拉', '阿米娅', '塞雷娅',
    ])
  })

  it('breaks equal cultivation with rarity then name so repeated sorts are stable', () => {
    const options = [
      option('char_c', '陈', { elite: 1, level: 70, rarity: 5 }),
      option('char_a', '阿米娅', { elite: 1, level: 70, rarity: 6 }),
      option('char_b', '艾雅法拉', { elite: 1, level: 70, rarity: 6 }),
    ]

    expect(sortOperatorPickerOptions(options, 'desc').map(item => item.id)).toEqual([
      'char_a', 'char_b', 'char_c',
    ])
    expect(sortOperatorPickerOptions(options, 'asc').map(item => item.id)).toEqual([
      'char_a', 'char_b', 'char_c',
    ])
  })

  it('falls back to rarity and name when cultivation fields are missing', () => {
    const options = [
      option('char_a', '阿米娅', { rarity: 5 }),
      option('char_b', '陈', { rarity: 6 }),
      option('char_c', '塞雷娅', { rarity: 4 }),
    ]

    const descending = sortOperatorPickerOptions(options, 'desc').map(item => item.id)
    const ascending = sortOperatorPickerOptions([...options].reverse(), 'asc').map(item => item.id)

    expect(descending).toEqual(['char_b', 'char_a', 'char_c'])
    expect(ascending).toEqual(descending)
  })
})
