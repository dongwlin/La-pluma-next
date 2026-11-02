import { describe, expect, it } from 'vitest'
import {
  countAppendedRows,
  initialLogFollowState,
  reduceLogFollow,
} from './logFollow'

const pausedWithCount = (count: number) => reduceLogFollow(
  reduceLogFollow(initialLogFollowState, { type: 'leave-bottom' }),
  { type: 'append', count },
)

describe('reduceLogFollow', () => {
  it('starts following with no unread rows', () => {
    expect(initialLogFollowState).toEqual({ paused: false, pendingCount: 0 })
  })

  it('pauses when leaving the bottom and keeps the count when already paused', () => {
    const paused = reduceLogFollow(initialLogFollowState, { type: 'leave-bottom' })
    expect(paused).toEqual({ paused: true, pendingCount: 0 })

    const counted = reduceLogFollow(paused, { type: 'append', count: 3 })
    expect(reduceLogFollow(counted, { type: 'leave-bottom' })).toBe(counted)
  })

  it('accumulates appended rows only while paused and ignores non-positive counts', () => {
    expect(reduceLogFollow(initialLogFollowState, { type: 'append', count: 5 }))
      .toBe(initialLogFollowState)

    const once = reduceLogFollow(pausedWithCount(0), { type: 'append', count: 2 })
    const twice = reduceLogFollow(once, { type: 'append', count: 3 })
    expect(twice).toEqual({ paused: true, pendingCount: 5 })

    expect(reduceLogFollow(twice, { type: 'append', count: 0 })).toBe(twice)
    expect(reduceLogFollow(twice, { type: 'append', count: -1 })).toBe(twice)
  })

  it('resumes and clears the count when reaching the bottom and is a no-op while following', () => {
    expect(reduceLogFollow(pausedWithCount(4), { type: 'reach-bottom' }))
      .toEqual(initialLogFollowState)
    expect(reduceLogFollow(
      reduceLogFollow(initialLogFollowState, { type: 'leave-bottom' }),
      { type: 'reach-bottom' },
    )).toEqual(initialLogFollowState)
    expect(reduceLogFollow(initialLogFollowState, { type: 'reach-bottom' }))
      .toBe(initialLogFollowState)
  })

  it('returns to the initial follow state unconditionally on reset', () => {
    expect(reduceLogFollow(pausedWithCount(7), { type: 'reset' }))
      .toEqual(initialLogFollowState)
    expect(reduceLogFollow(initialLogFollowState, { type: 'reset' }))
      .toBe(initialLogFollowState)
  })
})

describe('countAppendedRows', () => {
  it('counts positive row deltas between two content changes', () => {
    expect(countAppendedRows([1, 2], [1, 2, 3, 4])).toBe(2)
    expect(countAppendedRows([], [1])).toBe(1)
  })

  it('counts at least one row when the buffer rotates or shrinks without growing', () => {
    expect(countAppendedRows([1, 2, 3], [2, 3, 4])).toBe(1)
    expect(countAppendedRows([1, 2, 3], [4])).toBe(1)
  })
})
