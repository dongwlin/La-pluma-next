/**
 * 自动化定时时间纯模型
 *
 * schedule 的解析、格式化、规范化与编辑规则集中在这里，页面只提交一次编辑结果：
 * - 时间点统一为 `HH:mm`，解析会夹取到 00:00–23:59，非法文本回退 00:00；
 * - 规范化去掉非法与重复时间点，`enabled` 缺省视为启用（与旧本地草稿一致）；
 * - 编辑小时/分钟按 24/60 循环，重复时间点返回 `duplicate` 而不修改草稿；
 * - 新增时间点沿用迁移前顺序：从 12:00 起逐小时查找第一个未占用时间；
 * - wire 只发送启用项，本地 `entries` 保留禁用项。
 *
 * 模型不访问 React、网络或存储。
 */

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

/** 去掉非法时间与重复项；`enabled` 缺省视为启用，与迁移前一致。 */
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

/** 切换单行启用状态；越界索引不改变内容。 */
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
