import { describe, expect, it } from 'vitest'
import {
  buildLogView,
  collapseRepeatedLogs,
  formatLogTime,
  normalizeLevel,
  parseHistoryContent,
  parseHistoryLine,
  parseRealtimeLog,
  summarizeLog,
} from './logModel'
import type { LogEntry } from '../types'

const entry = (
  message: string,
  level: LogEntry['level'] = 'INFO',
  time = '10:00:00',
): LogEntry => ({ time, level, message })

describe('log parsing and normalization', () => {
  it('normalizes level aliases and falls back to INFO', () => {
    expect(normalizeLevel('err')).toBe('ERROR')
    expect(normalizeLevel('WARNING')).toBe('WARN')
    expect(normalizeLevel('trc')).toBe('DEBUG')
    expect(normalizeLevel('LOUD')).toBe('INFO')
    expect(normalizeLevel(undefined)).toBe('INFO')
  })

  it('formats a valid timestamp and drops an invalid one', () => {
    expect(formatLogTime('2026-07-22T10:11:12')).toBe('10:11:12')
    expect(formatLogTime('not-a-date')).toBe('')
    expect(formatLogTime(null)).toBe('')
  })

  it('parses bracketed MAA history lines with and without milliseconds', () => {
    expect(parseHistoryLine('[2026-07-22 10:11:12][INFO] 普通消息')).toEqual({
      time: '10:11:12',
      level: 'INFO',
      message: '普通消息',
    })
    expect(parseHistoryLine('[2026-07-22 10:11:12.345][WRN][thread-1] 警告消息')).toEqual({
      time: '10:11:12',
      level: 'WARN',
      message: '警告消息',
    })
    expect(parseHistoryLine('[2026-07-22 10:11:12][ERR][42] 错误消息')).toEqual({
      time: '10:11:12',
      level: 'ERROR',
      message: '错误消息',
    })
  })

  it('keeps the legacy time-level bracket format and unparsable lines', () => {
    expect(parseHistoryLine('[2026-07-22 10:11:12 DBG] 调试消息')).toEqual({
      time: '10:11:12',
      level: 'DEBUG',
      message: '调试消息',
    })
    expect(parseHistoryLine('没有时间戳的行')).toEqual({
      time: '',
      level: 'INFO',
      message: '没有时间戳的行',
    })
  })

  it('prefers a bracketed message over the realtime envelope', () => {
    expect(parseRealtimeLog({
      time: '2026-07-22T23:59:59',
      level: 'ERROR',
      message: '[2026-07-22 10:11:12][INF] 内层消息',
    })).toEqual({ time: '10:11:12', level: 'INFO', message: '内层消息' })

    expect(parseRealtimeLog({
      time: '2026-07-22T10:11:12',
      level: 'warn',
      message: '实时消息',
    })).toEqual({ time: '10:11:12', level: 'WARN', message: '实时消息' })

    expect(parseRealtimeLog(null)).toEqual({ time: '', level: 'INFO', message: '' })
  })

  it('parses history content by non-empty lines', () => {
    expect(parseHistoryContent('[2026-07-22 10:11:12][INFO] one\n\n[2026-07-22 10:11:13][WARN] two \n')).toEqual([
      { time: '10:11:12', level: 'INFO', message: 'one' },
      { time: '10:11:13', level: 'WARN', message: 'two ' },
    ])
    expect(parseHistoryContent(undefined)).toEqual([])
  })
})

describe('summarizeLog', () => {
  it('drops debug, timeless, blank and JSON-shaped rows', () => {
    expect(summarizeLog(entry('debug', 'DEBUG'))).toBeNull()
    expect(summarizeLog(entry('no time', 'INFO', ''))).toBeNull()
    expect(summarizeLog(entry('   '))).toBeNull()
    expect(summarizeLog(entry('{}'))).toBeNull()
    expect(summarizeLog(entry('"quoted"'))).toBeNull()
  })

  it('summarizes task callbacks and ignores routine subtasks', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | TaskChainStart {"taskchain":"Fight"}',
    ))).toEqual(entry('任务开始：作战'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | TaskChainCompleted {"taskchain":"Fight"}',
    ))).toEqual(entry('任务完成：作战'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | TaskChainError {"taskchain":"Fight"}',
    ))).toEqual(entry('任务失败：作战', 'ERROR'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskError {"subtask":"Infrast"}',
    ))).toEqual(entry('执行步骤失败：基建换班', 'ERROR'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | AllTasksCompleted {"taskchain":"Fight"}',
    ))).toBeNull()
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskStart {"subtask":"Fight"}',
    ))).toBeNull()
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"DepotInfo"}',
    ))).toEqual(entry('仓库识别数据已生成'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"Other"}',
    ))).toBeNull()
  })

  it('summarizes connection callbacks and keeps malformed callback payloads', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | AsyncCallInfo {"what":"Connect","details":{"ret":true,"cost":120}}',
    ))).toEqual(entry('设备连接完成，耗时 120 ms'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | AsyncCallInfo {"what":"Connect","details":{"ret":false}}',
    ))).toEqual(entry('设备连接失败', 'ERROR'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | ConnectionInfo {"what":"Connected","details":{"address":"127.0.0.1:5555"}}',
    ))).toEqual(entry('设备连接成功：127.0.0.1:5555'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | ConnectionInfo {"what":"ResolutionInfo","details":{"width":1280,"height":720}}',
    ))).toEqual(entry('设备分辨率：1280 x 720'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | ConnectionInfo {"what":"FastestWayToScreencap","details":{"method":"adb","cost":15}}',
    ))).toEqual(entry('已选择截图方式：adb（15 ms）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | ConnectionInfo {"what":"Unknown"}',
    ))).toBeNull()
    expect(summarizeLog(entry(
      'Assistant::append_callback | TaskChainStart {not-json}',
    ))).toEqual(entry('Assistant::append_callback | TaskChainStart {not-json}'))
  })

  it('summarizes task state updates and command lifecycle lines', () => {
    expect(summarizeLog(entry('任务状态更新: {"isRunning":true,"taskType":"StartUp"}')))
      .toEqual(entry('任务开始：启动游戏'))
    expect(summarizeLog(entry('任务状态更新: {"isRunning":false}')))
      .toEqual(entry('任务执行结束'))
    expect(summarizeLog(entry('任务状态更新: {not-json}'))).toBeNull()
    expect(summarizeLog(entry('执行命令: maa run --config foo, 等待完成: true')))
      .toEqual(entry('开始执行：自动化任务'))
    expect(summarizeLog(entry('执行命令: maa dir log'))).toBeNull()
    expect(summarizeLog(entry('命令执行完成: maa fight, 退出码: 0')))
      .toEqual(entry('MAA 命令执行完成'))
    expect(summarizeLog(entry('命令执行完成: maa fight, 退出码: 2')))
      .toEqual(entry('MAA 命令执行失败，退出码 2', 'ERROR'))
  })

  it('rewrites output prefixes and known noisy lines', () => {
    expect(summarizeLog(entry('临时任务文件已创建: /tmp/x'))).toBeNull()
    expect(summarizeLog(entry('stdout:  结果 '))).toEqual(entry('MAA 输出：结果'))
    expect(summarizeLog(entry('stderr: 提示'))).toEqual(entry('MAA 提示：提示', 'WARN'))
    expect(summarizeLog(entry('append_task Fight {'))).toEqual(entry('任务已加入队列：作战'))
    expect(summarizeLog(entry('Start | block'))).toEqual(entry('任务执行开始'))
    expect(summarizeLog(entry('Stop | block'))).toEqual(entry('任务执行结束'))
    expect(summarizeLog(entry('timeout when waiting socket connection')))
      .toEqual(entry('截图通道连接超时，正在切换备用方案', 'WARN'))
    expect(summarizeLog(entry('Killing child `adb`')))
      .toEqual(entry('已终止超时的截图进程', 'ERROR'))
    expect(summarizeLog(entry('Call `x` failed')))
      .toEqual(entry('ADB 调用失败，正在尝试备用方案', 'WARN'))
    expect(summarizeLog(entry('data is empty!')))
      .toEqual(entry('截图数据为空，正在切换备用方案', 'WARN'))
    expect(summarizeLog(entry('load resource'))).toBeNull()
    expect(summarizeLog(entry('load resource', 'WARN'))).toEqual(entry('load resource', 'WARN'))
    expect(summarizeLog(entry('普通消息'))).toEqual(entry('普通消息'))
  })
})

describe('buildLogView', () => {
  const logs: LogEntry[] = [
    entry('重复消息'),
    entry('重复消息', 'INFO', '10:00:01'),
    entry('没有时间', 'INFO', ''),
    entry('调试消息', 'DEBUG'),
    entry('失败消息', 'ERROR', '10:00:04'),
  ]

  it('derives summary or raw readable rows', () => {
    const summary = buildLogView(logs, { mode: 'summary', level: 'all', search: '', collapseRepeats: false })
    expect(summary.readable).toEqual([
      entry('重复消息'),
      entry('重复消息', 'INFO', '10:00:01'),
      entry('失败消息', 'ERROR', '10:00:04'),
    ])
    expect(summary.filtered).toHaveLength(3)
    expect(summary.visible).toHaveLength(3)

    const raw = buildLogView(logs, { mode: 'raw', level: 'all', search: '', collapseRepeats: false })
    expect(raw.readable).toHaveLength(5)
    expect(raw.filtered).toHaveLength(5)
  })

  it('filters by level and case-insensitive search after summary', () => {
    const byLevel = buildLogView(logs, { mode: 'raw', level: 'ERROR', search: '', collapseRepeats: false })
    expect(byLevel.filtered).toEqual([entry('失败消息', 'ERROR', '10:00:04')])

    const bySearch = buildLogView(logs, { mode: 'raw', level: 'all', search: '  调试 ', collapseRepeats: false })
    expect(bySearch.filtered).toEqual([entry('调试消息', 'DEBUG')])

    const searchTime = buildLogView(logs, { mode: 'raw', level: 'all', search: '10:00:04', collapseRepeats: false })
    expect(searchTime.filtered).toEqual([entry('失败消息', 'ERROR', '10:00:04')])

    const summaryLevel = buildLogView(logs, { mode: 'summary', level: 'DEBUG', search: '', collapseRepeats: false })
    expect(summaryLevel.filtered).toEqual([])
  })

  it('collapses consecutive duplicates and keeps the latest time', () => {
    const collapsed = buildLogView(logs, { mode: 'summary', level: 'all', search: '', collapseRepeats: true })
    expect(collapsed.visible).toEqual([
      { ...entry('重复消息', 'INFO', '10:00:01'), count: 2 },
      { ...entry('失败消息', 'ERROR', '10:00:04'), count: 1 },
    ])

    expect(collapseRepeatedLogs([
      entry('a', 'INFO', '10:00:00'),
      entry('a', 'WARN', '10:00:01'),
      entry('a', 'INFO', '10:00:02'),
    ])).toEqual([
      { ...entry('a', 'INFO', '10:00:00'), count: 1 },
      { ...entry('a', 'WARN', '10:00:01'), count: 1 },
      { ...entry('a', 'INFO', '10:00:02'), count: 1 },
    ])
  })

  it('returns empty views for empty input', () => {
    expect(buildLogView([], { mode: 'summary', level: 'all', search: '', collapseRepeats: true }))
      .toEqual({ readable: [], filtered: [], visible: [] })
  })
})
