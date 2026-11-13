import { describe, expect, it } from 'vitest'
import type { MaterialNode, TrainingQueueItem } from '../types'
import {
  getQueueMaterials,
  selectMissingMaterials,
  summarizeTargetMaterials,
} from './materials'

const material = (
  id: string,
  name: string,
  stillNeeded: number,
): MaterialNode => ({
  id,
  name,
  iconId: id,
  count: stillNeeded + 1,
  have: 1,
  needed: stillNeeded + 1,
  stillNeeded,
})

const queueItem = (overrides: Partial<TrainingQueueItem> = {}): TrainingQueueItem => ({
  operatorId: 'char_current',
  operator: { name: '阿米娅', rarity: 6, profession: 'CASTER' },
  currentElite: 1,
  targetElite: 2,
  materials: [material('30012', '固源岩', 2)],
  progress: 40,
  ...overrides,
})

describe('training materials', () => {
  it('keeps the server material order and appends LMD as the last gap', () => {
    const item = queueItem({
      materials: [material('30012', '固源岩', 2), material('30013', '聚酸酯', 0)],
      lmd: { needed: 100000, have: 1234, stillNeeded: 98766 },
    })

    expect(getQueueMaterials(item)).toEqual([
      material('30012', '固源岩', 2),
      material('30013', '聚酸酯', 0),
      {
        id: '4001',
        name: '龙门币',
        iconId: '4001',
        count: 100000,
        needed: 100000,
        have: 1234,
        stillNeeded: 98766,
      },
    ])
  })

  it('returns the original material list when no LMD entry exists', () => {
    const item = queueItem()

    expect(getQueueMaterials(item)).toBe(item.materials)
  })

  it('selects only materials that still have a gap', () => {
    expect(selectMissingMaterials([
      material('30012', '固源岩', 2),
      material('30013', '聚酸酯', 0),
      material('4001', '龙门币', 1),
    ]).map(entry => entry.id)).toEqual(['30012', '4001'])
  })

  it('summarizes an empty target without inventing materials', () => {
    expect(summarizeTargetMaterials(null)).toEqual({
      title: '材料筹备',
      subtitle: '添加目标后查看材料缺口',
      progress: 0,
      materials: [],
      missingMaterials: [],
    })
  })

  it('counts LMD as a remaining gap and reports a collected target', () => {
    const lmdOnly = summarizeTargetMaterials(queueItem({
      materials: [],
      lmd: { needed: 100000, have: 1234, stillNeeded: 98766 },
    }))
    expect(lmdOnly.title).toBe('阿米娅的材料')
    expect(lmdOnly.subtitle).toBe('精1 → 精2 · 还缺 1 种材料')
    expect(lmdOnly.missingMaterials.map(entry => entry.name)).toEqual(['龙门币'])

    const collected = summarizeTargetMaterials(queueItem({
      materials: [material('30012', '固源岩', 0)],
      progress: 100,
    }))
    expect(collected.subtitle).toBe('精1 → 精2 · 材料已集齐')
    expect(collected.missingMaterials).toEqual([])
    expect(collected.progress).toBe(100)
  })

  it('defaults a missing progress value to zero', () => {
    const item = queueItem()
    delete (item as { progress?: number }).progress

    expect(summarizeTargetMaterials(item).progress).toBe(0)
  })
})
