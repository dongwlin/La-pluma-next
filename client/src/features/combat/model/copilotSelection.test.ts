import { describe, expect, it } from 'vitest'
import type { CopilotSetItem } from '../types'
import {
  pendingCopilotItemIndexes,
  pendingCopilotPlanIndexes,
  restorableCopilotIndexes,
  selectedCopilotItemIndexes,
  serializeCopilotSelection,
  toggleAllCopilotSelection,
  toggleCopilotSelection,
} from './copilotSelection'

const item = (overrides: Partial<CopilotSetItem> = {}): CopilotSetItem => ({
  id: 100,
  uri: 'prts://100',
  ...overrides,
})

describe('serializeCopilotSelection', () => {
  it('deduplicates, drops non-integers and sorts ascending', () => {
    expect(serializeCopilotSelection([2, 0, 2, 1.5, Number.NaN, -1]))
      .toEqual([-1, 0, 2])
  })

  it('projects a selection onto the current list bounds', () => {
    expect(selectedCopilotItemIndexes(new Set([2, 0, 5, -1]), 3)).toEqual([0, 2])
    expect(selectedCopilotItemIndexes(new Set([0]), 0)).toEqual([])
  })
})

describe('pending selection', () => {
  it('subtracts run successes from the selected indexes', () => {
    expect(pendingCopilotItemIndexes(new Set([2, 0, 1]), new Set([1]))).toEqual([0, 2])
  })

  it('keeps failed and unstarted items pending in normal mode', () => {
    const copilots = [
      item({ completedModes: ['normal'] }),
      item({ completedModes: [] }),
      item(),
    ]
    expect(pendingCopilotPlanIndexes(copilots, 'normal')).toEqual([1, 2])
  })

  it('requires both modes for raid+both and only normal for preset formations', () => {
    const copilots = [
      item({ id: 1, completedModes: ['normal'] }),
      item({ id: 2, completedModes: ['raid'] }),
      item({ id: 3, completedModes: ['normal', 'raid'] }),
      item({ id: 4, presetFormation: true, completedModes: ['normal'] }),
    ]

    expect(pendingCopilotPlanIndexes(copilots, 'raid')).toEqual([0])
    expect(pendingCopilotPlanIndexes(copilots, 'both')).toEqual([0, 1])
  })
})

describe('restorableCopilotIndexes', () => {
  const copilots = [
    item({ id: 1, completedModes: ['normal'] }),
    item({ id: 2 }),
    item({ id: 3 }),
  ]

  it('uses every pending item when no local selection was saved', () => {
    expect(restorableCopilotIndexes(copilots, 'normal', undefined)).toEqual([1, 2])
  })

  it('intersects a saved selection with the plan pending set', () => {
    expect(restorableCopilotIndexes(copilots, 'normal', [2, 0, 1, 9])).toEqual([1, 2])
  })

  it('keeps an explicit empty selection empty', () => {
    expect(restorableCopilotIndexes(copilots, 'normal', [])).toEqual([])
  })

  it('keeps completed modes excluded after a plan refresh', () => {
    expect(restorableCopilotIndexes(copilots, 'normal', [0, 1])).toEqual([1])
  })
})

describe('selection toggles', () => {
  it('adds and removes one index without mutating the source set', () => {
    const source = new Set([0])
    expect(toggleCopilotSelection(source, 1)).toEqual(new Set([0, 1]))
    expect(toggleCopilotSelection(source, 0)).toEqual(new Set())
    expect(source).toEqual(new Set([0]))
  })

  it('selects all or clears when everything is selected', () => {
    expect(toggleAllCopilotSelection(new Set([0]), 2)).toEqual(new Set([0, 1]))
    expect(toggleAllCopilotSelection(new Set([0, 1]), 2)).toEqual(new Set())
    expect(toggleAllCopilotSelection(new Set(), 0)).toEqual(new Set())
  })
})
