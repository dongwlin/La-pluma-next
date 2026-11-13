import { describe, expect, it } from 'vitest'
import { resolveOperProgressOperatorId } from './operProgressOperator'

const operator = (id: string, name: string, profession?: string) => ({ id, name, profession })

describe('oper progress operator avatar lookup', () => {
  it('resolves a unique operator name to its id', () => {
    const operators = [
      operator('char_366_acdrop', '酸糖', 'SNIPER'),
      operator('char_010_chen', '陈', 'WARRIOR'),
    ]

    expect(resolveOperProgressOperatorId(operators, { name: '酸糖' })).toBe('char_366_acdrop')
    expect(resolveOperProgressOperatorId(operators, { name: ' 陈 ' })).toBe('char_010_chen')
  })

  it('returns null for empty or unmatched names so the placeholder stays', () => {
    const operators = [operator('char_002_amiya', '阿米娅', 'CASTER')]

    expect(resolveOperProgressOperatorId(operators, { name: '   ' })).toBeNull()
    expect(resolveOperProgressOperatorId(operators, { name: '未收录干员', role: 'Caster' })).toBeNull()
    expect(resolveOperProgressOperatorId([], { name: '阿米娅' })).toBeNull()
  })

  it('disambiguates repeated names with the stored profession', () => {
    const operators = [
      operator('char_002_amiya', '阿米娅', 'CASTER'),
      operator('char_1001_amiya2', '阿米娅', 'WARRIOR'),
      operator('char_1037_amiya3', '阿米娅', 'MEDIC'),
    ]

    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅', role: 'Caster' })).toBe('char_002_amiya')
    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅', role: 'Warrior' })).toBe('char_1001_amiya2')
    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅', role: 'Medic' })).toBe('char_1037_amiya3')
  })

  it('keeps the placeholder when repeated names cannot be resolved by profession', () => {
    const operators = [
      operator('char_002_amiya', '阿米娅', 'CASTER'),
      operator('char_1001_amiya2', '阿米娅', 'WARRIOR'),
    ]

    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅' })).toBeNull()
    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅', role: 'Unknown' })).toBeNull()
    expect(resolveOperProgressOperatorId(operators, { name: '阿米娅', role: 'Medic' })).toBeNull()
  })
})
