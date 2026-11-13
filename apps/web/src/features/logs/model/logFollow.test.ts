import { describe, expect, it } from 'vitest'
import {
  countAppendedRows,
  initialLogFollowState,
  reduceLogFollow,
} from './logFollow'
import type { LogEntry } from '../types'

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

const record = (id: string): LogEntry => ({ id, time: '10:00:00', level: 'INFO', message: 'same' })

describe('countAppendedRows', () => {
  it('uses stable identities even for equal text and a rotating window', () => {
    expect(countAppendedRows([record('a'), record('b')], [record('b'), record('c')])).toBe(1)
    expect(countAppendedRows([record('a')], [record('a'), record('b'), record('c')])).toBe(2)
  })

  it('does not report unchanged snapshots, unrelated filtered changes, or removals', () => {
    expect(countAppendedRows([record('a'), record('b')], [record('a'), record('b')])).toBe(0)
    expect(countAppendedRows([record('a'), record('b')], [record('b')])).toBe(0)
    expect(countAppendedRows([record('a')], [])).toBe(0)
  })

  it('falls back to source content with multiplicity for older servers', () => {
    const old: LogEntry = { time: '10:00:00', level: 'WARN', message: 'retry' }
    expect(countAppendedRows([old], [{ ...old }, { ...old }])).toBe(1)
    expect(countAppendedRows([old, old], [{ ...old }])).toBe(0)
    expect(countAppendedRows([old], [{ ...old, runId: 'other' }])).toBe(1)
  })
})
