/**
 * 日志导出的纯文本规则
 *
 * 导出是工作区的用户动作：它读取当前过滤结果（折叠前），由浏览器生成
 * Blob/objectURL/anchor 下载。本模块只固定导出文本与文件名的格式，便于
 * 脱离 DOM 测试；不访问 React、网络或文件系统。
 */

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
