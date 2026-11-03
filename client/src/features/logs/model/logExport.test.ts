import { describe, expect, it } from 'vitest'
import { buildLogExportFileName, formatLogExport } from './logExport'
import type { LogEntry } from '../types'
import { buildLogView, parseHistoryContent, parseRealtimeLog } from './logModel'

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

  it('exports exact historical source lines including blank lines and prefixes', () => {
    const source = '[2026-07-22 10:11:12.345][INF][thread] source  \n\nuntimed'
    expect(formatLogExport(parseHistoryContent(source))).toBe(source)
  })

  it('exports source envelopes with full metadata regardless of repeat folding', () => {
    const envelope = {
      id: 'source:1', sequence: 1, time: '2026-07-22T10:11:12.345Z', level: 'INFO',
      message: 'Assistant::append_callback | TaskChainError {"taskchain":"Fight"}',
      runId: 'run-1', operationId: 'op-1',
    }
    const record = parseRealtimeLog(envelope)
    const options = { events: 'all', level: 'all', search: '', collapseRepeats: true } as const
    const folded = buildLogView([record, record], options)
    const expanded = buildLogView([record, record], { ...options, collapseRepeats: false })
    expect(folded.visible).toHaveLength(1)
    expect(folded.visible[0]!.message).toBe('任务失败：作战')
    expect(expanded.selected).toEqual(folded.selected)
    expect(formatLogExport(folded.selected)).not.toContain('任务失败')
    expect(formatLogExport(folded.selected).split('\n').map(line => JSON.parse(line)))
      .toEqual([envelope, envelope])
  })

  it('builds a dated text file name from the UTC date', () => {
    expect(buildLogExportFileName(new Date('2026-07-22T10:11:12Z'))).toBe('maa-log-2026-07-22.txt')
    expect(buildLogExportFileName(new Date('2026-12-31T23:59:59Z'))).toBe('maa-log-2026-12-31.txt')
  })
})
