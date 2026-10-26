import { describe, expect, it } from 'vitest'
import { buildLogExportFileName, formatLogExport } from './logExport'
import type { LogEntry } from '../types'

const entry = (
  message: string,
  level: LogEntry['level'] = 'INFO',
  time = '10:00:00',
): LogEntry => ({ time, level, message })

describe('log export formatting', () => {
  it('formats each filtered entry as time, level and message lines', () => {
    const entries = [
      entry('第一行'),
      entry('错误行', 'ERROR', '10:00:01'),
      entry('无时间行', 'WARN', ''),
    ]

    expect(formatLogExport(entries)).toBe([
      '[10:00:00] [INFO] 第一行',
      '[10:00:01] [ERROR] 错误行',
      '[] [WARN] 无时间行',
    ].join('\n'))
  })

  it('returns an empty string for an empty selection', () => {
    expect(formatLogExport([])).toBe('')
  })

  it('builds a dated text file name from the UTC date', () => {
    expect(buildLogExportFileName(new Date('2026-07-22T10:11:12Z'))).toBe('maa-log-2026-07-22.txt')
    expect(buildLogExportFileName(new Date('2026-12-31T23:59:59Z'))).toBe('maa-log-2026-12-31.txt')
  })
})
