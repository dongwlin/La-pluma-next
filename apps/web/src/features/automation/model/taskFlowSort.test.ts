import { describe, expect, it } from 'vitest'
import {
  POINTER_SORT_ACTIVATION_PX,
  getPointerSortTargetIndex,
  hasPointerSortActivated,
  moveTaskFlowItem,
  placeClosedownLast,
} from './taskFlowSort'

const task = (id: string, commandId?: string) => (
  commandId ? { id, name: id, commandId } : { id, name: id }
)

describe('automation task flow sorting', () => {
  it('waits for the full 10px pointer threshold in any direction', () => {
    expect(POINTER_SORT_ACTIVATION_PX).toBe(10)
    expect(hasPointerSortActivated(0, 0, 6, 7)).toBe(false)
    expect(hasPointerSortActivated(0, 0, 6, 8)).toBe(true)
    expect(hasPointerSortActivated(0, 0, 10, 0)).toBe(true)
    expect(hasPointerSortActivated(2, 2, -8, 2)).toBe(true)
  })

  it('reorders immutably and preserves every task', () => {
    const original = [task('one'), task('two'), task('three')]
    const reordered = moveTaskFlowItem(original, 0, 2)

    expect(reordered.map(item => item.id)).toEqual(['two', 'three', 'one'])
    expect(original.map(item => item.id)).toEqual(['one', 'two', 'three'])
    expect(reordered).not.toBe(original)
  })

  it('moves upward with the same insertion-slot semantics', () => {
    const original = [task('a'), task('b'), task('c')]

    expect(moveTaskFlowItem(original, 2, 0).map(item => item.id)).toEqual(['c', 'a', 'b'])
    expect(moveTaskFlowItem(original, 1, 0).map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('keeps the same flow when a keyboard move would leave the list', () => {
    const original = [task('one'), task('two')]

    expect(moveTaskFlowItem(original, 0, -1)).toBe(original)
    expect(moveTaskFlowItem(original, 1, 2)).toBe(original)
    expect(moveTaskFlowItem(original, 0, 0)).toBe(original)
    expect(moveTaskFlowItem(original, -1, 0)).toBe(original)
    expect(moveTaskFlowItem(original, 2, 0)).toBe(original)
  })

  it('keeps length and membership for every valid move pair', () => {
    const original = [task('a'), task('b'), task('c'), task('d')]
    const originalIds = original.map(item => item.id).sort()

    for (let from = 0; from < original.length; from += 1) {
      for (let to = 0; to < original.length; to += 1) {
        const moved = moveTaskFlowItem(original, from, to)
        expect(moved).toHaveLength(original.length)
        expect(moved.map(item => item.id).sort()).toEqual(originalIds)
        if (from !== to) expect(moved[to]?.id).toBe(original[from]?.id)
      }
    }

    const roundTrip = moveTaskFlowItem(moveTaskFlowItem(original, 0, 3), 3, 0)
    expect(roundTrip.map(item => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('uses insertion slots after removing the dragged item when moving downward', () => {
    const original = [task('a'), task('b'), task('c')]
    const midpointById = new Map([['a', 50], ['b', 150], ['c', 250]])
    const targetIndex = getPointerSortTargetIndex(
      original,
      'a',
      151,
      taskId => midpointById.get(taskId) ?? null,
    )

    expect(targetIndex).toBe(1)
    expect(moveTaskFlowItem(original, 0, targetIndex).map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('resolves insertion slots above the first item, below the last and for unknown items', () => {
    const flow = [task('a'), task('b'), task('c')]
    const midpoints = new Map([['a', 50], ['b', 150], ['c', 250]])
    const midpoint = (taskId: string) => midpoints.get(taskId) ?? null

    expect(getPointerSortTargetIndex(flow, 'c', 0, midpoint)).toBe(0)
    expect(getPointerSortTargetIndex(flow, 'a', 400, midpoint)).toBe(2)
    expect(getPointerSortTargetIndex(flow, 'missing', 100, midpoint)).toBe(-1)
  })

  it('skips unmeasurable items without losing their relative position', () => {
    const flow = [task('a'), task('b'), task('c')]
    const onlyC = (taskId: string) => (taskId === 'c' ? 100 : null)

    expect(getPointerSortTargetIndex(flow, 'a', 50, onlyC)).toBe(1)
    expect(getPointerSortTargetIndex(flow, 'a', 150, onlyC)).toBe(2)
  })

  it('keeps closedown last by command id or legacy id prefix', () => {
    const flow = [
      task('startup-1', 'startup'),
      task('closedown-1', 'closedown'),
      task('fight-1', 'fight'),
      task('closedown-2'),
    ]

    expect(placeClosedownLast(flow).map(item => item.id)).toEqual([
      'startup-1',
      'fight-1',
      'closedown-1',
      'closedown-2',
    ])
  })

  it('does not reorder flows without a closedown step', () => {
    const flow = [task('startup-1', 'startup'), task('fight-1', 'fight')]

    expect(placeClosedownLast(flow)).toEqual(flow)
    expect(placeClosedownLast(flow)).not.toBe(flow)
  })
})
