import { describe, expect, it } from 'vitest'
import type { TrainingOperator } from '../types'
import {
  OPERATOR_RENDER_BATCH_SIZE,
  describeOperatorRow,
  filterOperatorRows,
  nextOperatorRenderLimit,
  normalizeOperatorSearchTerm,
  paginateOperatorRows,
  resolveOperatorEmptyState,
} from './operatorRows'

const operator = (
  id: string,
  name: string,
  overrides: Partial<TrainingOperator> = {},
): TrainingOperator => ({
  id,
  name,
  rarity: 6,
  profession: 'SNIPER',
  currentElite: 1,
  targetElite: 2,
  owned: true,
  canTrain: true,
  hasMaterialData: true,
  disabledReason: null,
  ...overrides,
})

describe('training operator rows', () => {
  it('matches names case-insensitively after trimming the search term', () => {
    const rows = [operator('a', 'Amiya'), operator('b', '能天使')]

    expect(normalizeOperatorSearchTerm('  AMI  ')).toBe('ami')
    expect(filterOperatorRows(rows, '  ami  ').map(row => row.id)).toEqual(['a'])
    expect(filterOperatorRows(rows, '能').map(row => row.id)).toEqual(['b'])
    expect(filterOperatorRows(rows, '不存在')).toEqual([])
  })

  it('returns a fresh list for an empty search term', () => {
    const rows = [operator('a', '阿米娅')]
    const filtered = filterOperatorRows(rows, '   ')

    expect(filtered).toEqual(rows)
    expect(filtered).not.toBe(rows)
  })

  it('renders the first batch and reports how many rows remain', () => {
    const rows = Array.from({ length: 80 }, (_, index) => operator(`char_${index}`, `干员${index}`))

    const first = paginateOperatorRows(rows, OPERATOR_RENDER_BATCH_SIZE)
    expect(first.rows).toHaveLength(72)
    expect(first.hiddenCount).toBe(8)

    const rest = paginateOperatorRows(rows, nextOperatorRenderLimit(OPERATOR_RENDER_BATCH_SIZE))
    expect(rest.rows).toHaveLength(80)
    expect(rest.hiddenCount).toBe(0)
  })

  it('keeps batching safe for empty, oversized and negative limits', () => {
    const rows = [operator('a', '阿米娅')]

    expect(paginateOperatorRows(rows, 0)).toEqual({ rows: [], hiddenCount: 1 })
    expect(paginateOperatorRows(rows, 10)).toEqual({ rows, hiddenCount: 0 })
    expect(nextOperatorRenderLimit(0)).toBe(OPERATOR_RENDER_BATCH_SIZE)
    expect(nextOperatorRenderLimit(-5)).toBe(OPERATOR_RENDER_BATCH_SIZE)
  })

  it('prefers a search or rarity hint over the status-specific empty state', () => {
    expect(resolveOperatorEmptyState({ status: 'trainable', rarity: '' }, '  ').title)
      .toBe('没有可养成干员')
    expect(resolveOperatorEmptyState({ status: 'owned', rarity: '' }, '').title)
      .toBe('还没有已拥有干员')
    expect(resolveOperatorEmptyState({ status: 'all', rarity: '' }, '').title)
      .toBe('没有干员数据')
    expect(resolveOperatorEmptyState({ status: 'trainable', rarity: '' }, '阿米娅').title)
      .toBe('没有找到符合条件的干员')
    expect(resolveOperatorEmptyState({ status: 'trainable', rarity: '6' }, '').description)
      .toBe('换个名称、稀有度或状态筛选再试。')
  })

  it('derives the card action without letting queue membership hide an unowned row', () => {
    expect(describeOperatorRow(operator('a', '阿米娅'), false)).toEqual({
      isOwned: true,
      canAdd: true,
      actionLabel: '添加',
    })
    expect(describeOperatorRow(operator('a', '阿米娅'), true).actionLabel).toBe('已添加')
    expect(describeOperatorRow(operator('a', '阿米娅'), true).canAdd).toBe(false)
    expect(describeOperatorRow(operator('a', '阿米娅', { owned: false }), false).actionLabel)
      .toBe('未拥有')
    expect(describeOperatorRow(operator('a', '阿米娅', { hasMaterialData: false }), false).actionLabel)
      .toBe('暂无数据')
    expect(describeOperatorRow(
      operator('a', '阿米娅', { disabledReason: 'already_elite2' }),
      false,
    ).actionLabel).toBe('已完成')
    expect(describeOperatorRow(operator('a', '阿米娅', { canTrain: false }), false).canAdd)
      .toBe(false)
  })
})
