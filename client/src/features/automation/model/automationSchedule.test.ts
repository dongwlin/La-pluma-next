import { describe, expect, it } from 'vitest'
import {
  MAX_SCHEDULE_ENTRIES,
  activeScheduleTimes,
  appendScheduleEntry,
  createDefaultScheduleEntries,
  findNextScheduleTime,
  formatScheduleTime,
  normalizeScheduleEntries,
  normalizeScheduleTimes,
  parseScheduleTime,
  removeScheduleEntry,
  scheduleEntriesFromTimes,
  setScheduleEntryEnabled,
  updateScheduleTimeEntry,
} from './automationSchedule'

describe('automation schedule time parsing', () => {
  it('formats and parses the HH:mm shape used by the local draft and wire', () => {
    expect(formatScheduleTime(8, 5)).toBe('08:05')
    expect(formatScheduleTime(0, 0)).toBe('00:00')
    expect(formatScheduleTime(23, 59)).toBe('23:59')
    expect(parseScheduleTime('08:30')).toEqual({ hour: 8, minute: 30 })
    expect(parseScheduleTime('8:5')).toEqual({ hour: 8, minute: 5 })
  })

  it('clamps malformed times instead of producing NaN input values', () => {
    expect(parseScheduleTime('99:99')).toEqual({ hour: 23, minute: 59 })
    expect(parseScheduleTime('-1:-1')).toEqual({ hour: 0, minute: 0 })
    expect(parseScheduleTime('')).toEqual({ hour: 0, minute: 0 })
    expect(parseScheduleTime('early')).toEqual({ hour: 0, minute: 0 })
  })

  it('normalizes invalid and duplicate entries while defaulting enabled to true', () => {
    expect(normalizeScheduleEntries([
      { time: '08:00', enabled: false },
      { time: '08:00', enabled: true },
      { time: '8:00', enabled: true },
      { time: '14:00', enabled: undefined as unknown as boolean },
    ])).toEqual([
      { time: '08:00', enabled: false },
      { time: '14:00', enabled: true },
    ])
    expect(normalizeScheduleTimes(['08:00', '08:00', '24:00', '23:59']))
      .toEqual(['08:00', '23:59'])
  })

  it('keeps the original enabled flag on every editing helper', () => {
    const entries = [{ time: '08:00', enabled: true }, { time: '14:00', enabled: false }]
    const toggled = setScheduleEntryEnabled(entries, 1, true)

    expect(toggled).toEqual([{ time: '08:00', enabled: true }, { time: '14:00', enabled: true }])
    expect(entries[1]).toEqual({ time: '14:00', enabled: false })
    expect(setScheduleEntryEnabled(entries, 9, true)).toEqual(entries)
  })
})

describe('automation schedule defaults and candidates', () => {
  it('returns fresh default rows so drafts never share mutable entries', () => {
    expect(MAX_SCHEDULE_ENTRIES).toBe(6)
    const first = createDefaultScheduleEntries()
    const second = createDefaultScheduleEntries()

    expect(first).toEqual([
      { time: '08:00', enabled: true },
      { time: '14:00', enabled: true },
      { time: '20:00', enabled: true },
    ])
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
  })

  it('starts at noon and picks the first unused hourly slot', () => {
    expect(findNextScheduleTime([])).toBe('12:00')
    expect(findNextScheduleTime([{ time: '12:00', enabled: true }])).toBe('13:00')
    expect(findNextScheduleTime([
      { time: '08:00', enabled: true },
      { time: '11:00', enabled: true },
    ])).toBe('12:00')
    // 禁用行同样占用时间点，避免新增后与未启用行重复。
    expect(findNextScheduleTime([
      { time: '12:00', enabled: false },
      { time: '13:00', enabled: true },
    ])).toBe('14:00')
  })

  it('wraps past midnight and returns null when all 24 hours are taken', () => {
    const evening = Array.from({ length: 12 }, (_, index) => (
      { time: formatScheduleTime(12 + index, 0), enabled: true }
    ))
    expect(findNextScheduleTime(evening)).toBe('00:00')

    const fullDay = Array.from({ length: 24 }, (_, hour) => (
      { time: formatScheduleTime(hour, 0), enabled: true }
    ))
    expect(findNextScheduleTime(fullDay)).toBeNull()
    expect(appendScheduleEntry(fullDay)).toBeNull()
  })

  it('appends candidates immutably and preserves existing rows', () => {
    const entries = [{ time: '08:00', enabled: false }]
    const appended = appendScheduleEntry(entries)

    expect(appended).toEqual([
      { time: '08:00', enabled: false },
      { time: '12:00', enabled: true },
    ])
    expect(entries).toEqual([{ time: '08:00', enabled: false }])
  })

  it('removes a row without mutating the input', () => {
    const entries = [{ time: '08:00', enabled: true }, { time: '09:00', enabled: true }]

    expect(removeScheduleEntry(entries, 0)).toEqual([{ time: '09:00', enabled: true }])
    expect(removeScheduleEntry(entries, 5)).toEqual(entries)
    expect(entries).toHaveLength(2)
  })
})

describe('automation schedule time editing', () => {
  const entries = [
    { time: '08:30', enabled: true },
    { time: '12:45', enabled: false },
  ]
  const editedTime = (result: ReturnType<typeof updateScheduleTimeEntry>, index = 0) => (
    result.ok ? result.entries[index]?.time : null
  )

  it('wraps hours and minutes around their bounds', () => {
    expect(editedTime(updateScheduleTimeEntry(entries, 0, 'hour', 9))).toBe('09:30')
    expect(editedTime(updateScheduleTimeEntry(entries, 0, 'hour', 24))).toBe('00:30')
    expect(editedTime(updateScheduleTimeEntry(entries, 0, 'hour', -1))).toBe('23:30')
    expect(editedTime(updateScheduleTimeEntry(entries, 0, 'minute', 60))).toBe('08:00')
    expect(editedTime(updateScheduleTimeEntry(entries, 0, 'minute', -5))).toBe('08:55')
    expect(updateScheduleTimeEntry(entries, 0, 'hour', 9)).toEqual({
      ok: true,
      entries: [{ time: '09:30', enabled: true }, { time: '12:45', enabled: false }],
    })
  })

  it('rejects a duplicate time without changing any row', () => {
    const duplicateEntries = [
      { time: '08:30', enabled: true },
      { time: '12:30', enabled: false },
    ]
    const duplicate = updateScheduleTimeEntry(duplicateEntries, 1, 'hour', 8)

    expect(duplicate).toEqual({ ok: false, reason: 'duplicate' })
    expect(duplicateEntries).toEqual([
      { time: '08:30', enabled: true },
      { time: '12:30', enabled: false },
    ])
  })

  it('reports a missing row and falls back to the current part for non-finite input', () => {
    expect(updateScheduleTimeEntry(entries, 5, 'hour', 9)).toEqual({ ok: false, reason: 'missing' })
    expect(updateScheduleTimeEntry(entries, 0, 'hour', Number.NaN)).toEqual({
      ok: true,
      entries: [{ time: '08:30', enabled: true }, { time: '12:45', enabled: false }],
    })
  })
})

describe('automation schedule wire compatibility', () => {
  it('sends only enabled times and rehydrates legacy times as enabled rows', () => {
    const entries = [
      { time: '08:00', enabled: true },
      { time: '09:00', enabled: false },
      { time: '10:00', enabled: true },
    ]

    const times = activeScheduleTimes(entries)
    expect(times).toEqual(['08:00', '10:00'])
    expect(activeScheduleTimes([{ time: '09:00', enabled: false }])).toEqual([])
    expect(scheduleEntriesFromTimes(times)).toEqual([
      { time: '08:00', enabled: true },
      { time: '10:00', enabled: true },
    ])
    expect(scheduleEntriesFromTimes(['10:00', '08:00', '10:00', 'bad'])).toEqual([
      { time: '10:00', enabled: true },
      { time: '08:00', enabled: true },
    ])
  })

  it('round-trips local entries through JSON without changing their shape', () => {
    const stored = {
      enabled: true,
      times: ['08:00'],
      entries: [
        { time: '08:00', enabled: true },
        { time: '14:00', enabled: false },
      ],
    }

    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
    expect(normalizeScheduleEntries(
      JSON.parse(JSON.stringify(stored.entries)) as typeof stored.entries,
    )).toEqual(stored.entries)
  })
})
