// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { TaskFlowItem } from '../types'
import { resolveExecutionStep } from '../utils/automationTaskProgress'
import { placeClosedownLast } from '../model/automationConfig'
import {
  getPointerSortTargetIndex,
  hasPointerSortActivated,
  moveTaskFlowItem,
} from './AutomationTasks'

const task = (id: string) => ({ id, name: id }) as TaskFlowItem

describe('AutomationTasks execution step mapping', () => {
  it('maps the enabled-step index past disabled tasks', () => {
    const flow = [
      { ...task('startup-1'), enabled: false },
      { ...task('fight-1'), enabled: true },
      { ...task('recruit-1'), enabled: true },
    ]

    expect(resolveExecutionStep(flow, { currentStep: 0, currentTaskId: null })).toBe(1)
    expect(resolveExecutionStep(flow, { currentStep: 1, currentTaskId: null })).toBe(2)
  })

  it('prefers the task id when the server provides it', () => {
    const flow = [task('startup-1'), task('fight-1'), task('recruit-1')]

    expect(resolveExecutionStep(flow, { currentStep: 0, currentTaskId: 'recruit-1' })).toBe(2)
    expect(resolveExecutionStep(flow, { currentStep: null, currentTaskId: 'missing' })).toBe(-1)
  })
})

describe('AutomationTasks ordering', () => {
  it('waits for the full 10px pointer threshold', () => {
    expect(hasPointerSortActivated(0, 0, 6, 7)).toBe(false)
    expect(hasPointerSortActivated(0, 0, 6, 8)).toBe(true)
  })

  it('reorders immutably and preserves every task', () => {
    const original = [task('one'), task('two'), task('three')]
    const reordered = moveTaskFlowItem(original, 0, 2)

    expect(reordered.map(item => item.id)).toEqual(['two', 'three', 'one'])
    expect(original.map(item => item.id)).toEqual(['one', 'two', 'three'])
  })

  it('keeps the same flow when a keyboard move would leave the list', () => {
    const original = [task('one'), task('two')]

    expect(moveTaskFlowItem(original, 0, -1)).toBe(original)
    expect(moveTaskFlowItem(original, 1, 2)).toBe(original)
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

  it('keeps closedown last when a deleted task is inserted back after it', () => {
    const restored = [
      task('startup-1'),
      { ...task('closedown-1'), commandId: 'closedown' },
      task('fight-1'),
    ]

    expect(placeClosedownLast(restored).map(item => item.id)).toEqual([
      'startup-1',
      'fight-1',
      'closedown-1',
    ])
  })
})
