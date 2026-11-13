import type { LogEntry } from '../types'

/** 实时记录保留完整信封，历史记录保留完整源行；兼容旧条目的文本格式。 */
export function formatLogExport(entries: readonly LogEntry[]): string {
  return entries
    .map(log => log.envelope
      ? JSON.stringify(log.envelope)
      : log.sourceText ?? `[${log.time}] [${log.level}] ${log.message}`)
    .join('\n')
}

/** 使用 UTC 日期（与迁移前 `toISOString().split('T')[0]` 一致）。 */
export function buildLogExportFileName(date: Date): string {
  return `maa-log-${date.toISOString().split('T')[0]}.txt`
}
