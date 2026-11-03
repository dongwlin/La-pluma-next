export interface ScheduleTimeEntry {
  time: string
  enabled: boolean
}

export type ScheduleTimePart = 'hour' | 'minute'

export type ScheduleTimeUpdate =
  | { ok: true; entries: ScheduleTimeEntry[] }
  | { ok: false; reason: 'missing' | 'duplicate' }

/** 界面上的“新增定时”上限，与迁移前页面的按钮条件一致。 */
export const MAX_SCHEDULE_ENTRIES = 6

const DEFAULT_SCHEDULE_TIMES = ['08:00', '14:00', '20:00'] as const
/** 新增时间点从中午开始扫描，与迁移前的候选顺序一致。 */
const SCHEDULE_ADD_START_HOUR = 12
const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** 默认执行时间；每次返回新对象，避免草稿之间共享可变的条目。 */
export function createDefaultScheduleEntries(): ScheduleTimeEntry[] {
  return DEFAULT_SCHEDULE_TIMES.map(time => ({ time, enabled: true }))
}

export function normalizeScheduleTimes(times: string[]): string[] {
  return [...new Set(times.filter(time => scheduleTimePattern.test(time)))]
}

export function formatScheduleTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function parseScheduleTime(time: string): { hour: number; minute: number } {
  const [hourText = '0', minuteText = '0'] = time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  return {
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0,
  }
}

export function normalizeScheduleEntries(entries: ScheduleTimeEntry[]): ScheduleTimeEntry[] {
  const normalized: ScheduleTimeEntry[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!scheduleTimePattern.test(entry.time) || seen.has(entry.time)) continue
    seen.add(entry.time)
    normalized.push({ time: entry.time, enabled: entry.enabled !== false })
  }

  return normalized
}

export function scheduleEntriesFromTimes(times: string[]): ScheduleTimeEntry[] {
  return normalizeScheduleEntries(
    normalizeScheduleTimes(times).map(time => ({ time, enabled: true })),
  )
}

/** wire 与 setupSchedule 使用的时间点：只包含启用项。 */
export function activeScheduleTimes(entries: ScheduleTimeEntry[]): string[] {
  return entries.filter(entry => entry.enabled).map(entry => entry.time)
}

/** 从 12:00 起逐小时查找第一个未占用的整点；24 个整点都已占用时返回 null。 */
export function findNextScheduleTime(entries: readonly ScheduleTimeEntry[]): string | null {
  const existingTimes = new Set(entries.map(entry => entry.time))
  for (let offset = 0; offset < 24; offset += 1) {
    const time = formatScheduleTime((SCHEDULE_ADD_START_HOUR + offset) % 24, 0)
    if (!existingTimes.has(time)) return time
  }
  return null
}

/** 追加默认候选时间；没有可用时间时返回 null，由调用方决定提示文案。 */
export function appendScheduleEntry(entries: readonly ScheduleTimeEntry[]): ScheduleTimeEntry[] | null {
  const nextTime = findNextScheduleTime(entries)
  if (!nextTime) return null
  return [...entries, { time: nextTime, enabled: true }]
}

/** 删除指定行；越界索引返回与输入内容相同的新数组。 */
export function removeScheduleEntry(
  entries: readonly ScheduleTimeEntry[],
  index: number,
): ScheduleTimeEntry[] {
  return entries.filter((_, itemIndex) => itemIndex !== index)
}

export function setScheduleEntryEnabled(
  entries: readonly ScheduleTimeEntry[],
  index: number,
  enabled: boolean,
): ScheduleTimeEntry[] {
  return entries.map((entry, itemIndex) => (
    itemIndex === index ? { ...entry, enabled } : entry
  ))
}

const wrapTimePart = (value: number, modulo: number, fallback: number) => (
  Number.isFinite(value)
    ? ((Math.trunc(value) % modulo) + modulo) % modulo
    : fallback
)

/**
 * 修改一行的时或分。
 *
 * - 数值按 24/60 循环（减到 0 以下回到上限，超过上限回到 0）；
 * - 与其它行时间相同时返回 `duplicate`，不改动任何条目；
 * - 索引不存在返回 `missing`，非有限数值保留原时间部分。
 */
export function updateScheduleTimeEntry(
  entries: readonly ScheduleTimeEntry[],
  index: number,
  part: ScheduleTimePart,
  rawValue: number,
): ScheduleTimeUpdate {
  const currentEntry = entries[index]
  if (!currentEntry) return { ok: false, reason: 'missing' }

  const parsed = parseScheduleTime(currentEntry.time)
  const nextHour = wrapTimePart(part === 'hour' ? rawValue : parsed.hour, 24, parsed.hour)
  const nextMinute = wrapTimePart(part === 'minute' ? rawValue : parsed.minute, 60, parsed.minute)
  const nextTime = formatScheduleTime(nextHour, nextMinute)

  if (entries.some((entry, itemIndex) => itemIndex !== index && entry.time === nextTime)) {
    return { ok: false, reason: 'duplicate' }
  }

  return {
    ok: true,
    entries: entries.map((entry, itemIndex) => (
      itemIndex === index ? { ...entry, time: nextTime } : entry
    )),
  }
}
