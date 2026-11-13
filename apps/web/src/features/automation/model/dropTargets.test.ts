import { describe, expect, it } from 'vitest'
import { formatDropTargets, parseDropTargets } from './dropTargets'

describe('automation drop targets', () => {
  it('treats missing values as no target', () => {
    expect(parseDropTargets(undefined)).toEqual([])
    expect(parseDropTargets(null)).toEqual([])
    expect(parseDropTargets('')).toEqual([])
    expect(formatDropTargets([])).toBe('')
  })

  it('parses the comma-separated item id and count format', () => {
    expect(parseDropTargets('30011=10,30062=5')).toEqual([
      { itemId: '30011', count: 10 },
      { itemId: '30062', count: 5 },
    ])
    expect(parseDropTargets(' 30011 = 010 , 30062=5 ')).toEqual([
      { itemId: '30011', count: 10 },
      { itemId: '30062', count: 5 },
    ])
    expect(parseDropTargets('S2-1_extra-2=3')).toEqual([
      { itemId: 'S2-1_extra-2', count: 3 },
    ])
  })

  it('parses the legacy object shape saved by older drafts', () => {
    expect(parseDropTargets({ 30011: 10, 30062: '5' })).toEqual([
      { itemId: '30011', count: 10 },
      { itemId: '30062', count: 5 },
    ])
    expect(parseDropTargets({ '300 11': 1 })).toBeNull()
  })

  it('rejects any invalid entry so execution is blocked before submission', () => {
    const invalidValues = [
      '30011',
      '=10',
      '30011=0',
      '30011=-1',
      '30011=1.5',
      '30011=abc',
      '300 11=1',
      '30011=10,oops',
      42,
    ]

    for (const value of invalidValues) {
      expect(parseDropTargets(value)).toBeNull()
    }
  })

  it('preserves duplicate entries and order for compatibility', () => {
    expect(parseDropTargets('30011=1,30062=2,30011=3')).toEqual([
      { itemId: '30011', count: 1 },
      { itemId: '30062', count: 2 },
      { itemId: '30011', count: 3 },
    ])
  })

  it('formats a canonical value that parses back to the same targets', () => {
    const canonical = formatDropTargets([
      { itemId: '30011', count: 10 },
      { itemId: '30062', count: 5 },
    ])
    expect(canonical).toBe('30011=10,30062=5')
    expect(parseDropTargets(canonical)).toEqual(parseDropTargets('30011=10, 30062=5'))

    const legacyObject = { 30011: 10, 30062: '5' }
    const targets = parseDropTargets(legacyObject)!
    expect(JSON.parse(JSON.stringify(targets))).toEqual(targets)
    expect(parseDropTargets(formatDropTargets(targets))).toEqual(targets)
  })
})
