import { describe, expect, it } from 'vitest'
import {
  buildLogContentFingerprint,
  buildLogView,
  collapseRepeatedLogs,
  filterLogsByRunId,
  formatLogRawDetail,
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

  it('prefers a bracketed message over the realtime envelope and keeps the run identity', () => {
    expect(parseRealtimeLog({
      time: '2026-07-22T23:59:59',
      level: 'ERROR',
      message: '[2026-07-22 10:11:12][INF] 内层消息',
      runId: 'run-1',
      operationId: 'op-1',
    })).toEqual({ time: '10:11:12', level: 'INFO', message: '内层消息', runId: 'run-1', operationId: 'op-1' })

    expect(parseRealtimeLog({
      time: '2026-07-22T10:11:12',
      level: 'warn',
      message: '实时消息',
    })).toEqual({ time: '10:11:12', level: 'WARN', message: '实时消息' })

    expect(parseRealtimeLog(null)).toEqual({ time: '', level: 'INFO', message: '' })
  })

  it('keeps the envelope fallback fields and the run identity together', () => {
    expect(parseRealtimeLog({
      time: '2026-07-22T10:11:12',
      level: 'warn',
      message: '实时消息',
      runId: 'run-2',
      operationId: 'op-2',
    })).toEqual({ time: '10:11:12', level: 'WARN', message: '实时消息', runId: 'run-2', operationId: 'op-2' })

    // 非 runId/operationId 字段或非字符串值不会进入条目
    expect(parseRealtimeLog({
      time: '2026-07-22T10:11:12',
      level: 'warn',
      message: '实时消息',
      runId: 42,
      operationId: null,
    })).toEqual({ time: '10:11:12', level: 'WARN', message: '实时消息' })

    expect(parseRealtimeLog({ message: '只有 runId', runId: 'run-3' })).toEqual({
      time: '',
      level: 'INFO',
      message: '只有 runId',
      runId: 'run-3',
    })
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
    ))).toEqual(entry('任务开始：作战（Fight）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | TaskChainStart {"taskchain":"自动公招"}',
    ))).toEqual(entry('任务开始：自动公招'))
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
      'Assistant::append_callback | SubTaskStart {"subtask":"Fight","details":{"task":"StartButton2"}}',
    ))).toBeNull()
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"DepotInfo"}',
    ))).toEqual(entry('仓库识别数据已生成'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"Other"}',
    ))).toBeNull()
  })

  it('summarizes copilot file loads and in-battle actions with readable fallbacks', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotListLoadTaskFileSuccess","details":{"stage_name":"1-7","file_name":"crowd.json"}}',
    ))).toEqual(entry('开始作业：1-7（crowd.json）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotListLoadTaskFileSuccess","details":{"file_name":"crowd.json"}}',
    ))).toEqual(entry('开始作业：crowd.json'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotListLoadTaskFileSuccess","details":{}}',
    ))).toEqual(entry('开始加载作业文件'))

    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotAction","details":{"target":"维什·德拉克萨","elapsed_time":1234}}',
    ))).toEqual(entry('战斗进行中：维什·德拉克萨 · 已用 1234ms'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotAction","details":{"target":"山"}}',
    ))).toEqual(entry('战斗进行中：山'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotAction","details":{"elapsed_time":88}}',
    ))).toEqual(entry('战斗进行中 · 已用 88ms'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"CopilotAction","details":{}}',
    ))).toEqual(entry('战斗进行中'))
  })

  it('summarizes stage drops by joining item names and counts', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"StageDrops","details":{"stars":3,"drops":[{"itemName":"固源岩","quantity":2},{"itemName":"龙门币","quantity":360}]}}',
    ))).toEqual(entry('掉落：固源岩 ×2、龙门币 ×360'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"StageDrops","details":{"drops":[{"itemName":"技巧概要·卷1"}]}}',
    ))).toEqual(entry('掉落：技巧概要·卷1'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"StageDrops","details":{"drops":[{"quantity":3},{"itemName":"  "}],"stars":2}}',
    ))).toBeNull()
  })

  it('summarizes stage clear markers and mission failure from subtask starts', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskStart {"taskchain":"Copilot","subtask":"ProcessTask","details":{"task":"StageDrops-Stars-3"}}',
    ))).toEqual(entry('三星通关'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"StageDrops-Stars-3"}',
    ))).toEqual(entry('三星通关'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskStart {"taskchain":"Copilot","subtask":"ProcessTask","details":{"task":"StageDrops-Stars-Adverse"}}',
    ))).toEqual(entry('险情通关'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"StageDrops-Adverse"}',
    ))).toEqual(entry('险情通关'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskStart {"taskchain":"Copilot","subtask":"ProcessTask","details":{"task":"FightMissionFailed"}}',
    ))).toEqual(entry('作战失败', 'ERROR'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskStart {"taskchain":"Fight","subtask":"ProcessTask","details":{"task":"MissionFailedFlag"}}',
    ))).toBeNull()
  })

  it('summarizes roguelike settlements, investments and events with missing fields', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeSettlement","details":{"game_pass":true,"floor":4,"step":23,"recruit":6,"score":128}}',
    ))).toEqual(entry('肉鸽结算：4层 23步 · 招募 6 · 得分 128'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeSettlement","details":{"recruit":3}}',
    ))).toEqual(entry('肉鸽结算：招募 3'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeSettlement","details":{"game_pass":false}}',
    ))).toEqual(entry('肉鸽结算完成'))

    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeInvestment","details":{"count":2,"total":5,"deposit":433}}',
    ))).toEqual(entry('投资：2（存款 433）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeInvestment","details":{"count":1,"deposit":-1}}',
    ))).toEqual(entry('投资：1'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeInvestment","details":{"count":0,"deposit":12}}',
    ))).toEqual(entry('投资：0（存款 12）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeInvestment","details":{"deposit":77}}',
    ))).toEqual(entry('投资完成（存款 77）'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeInvestment","details":{}}',
    ))).toEqual(entry('投资完成'))

    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeEvent","details":{"name":"不和谐之音","default_choose":1,"choose_option":0}}',
    ))).toEqual(entry('事件：不和谐之音'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeEvent","details":{}}',
    ))).toBeNull()
  })

  it('summarizes blackflow routing decisions with action point transitions', () => {
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"BlackFlowRoutingDecision","details":{"floor":3,"action_points_before":6,"action_points_after":4,"node_name":"险路狭道"}}',
    ))).toEqual(entry('第 3 层 · 行动点 6→4 · 险路狭道'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"BlackFlowRoutingDecision","details":{"floor":1,"node_name":"得偿所愿"}}',
    ))).toEqual(entry('第 1 层 · 得偿所愿'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"BlackFlowRoutingDecision","details":{"action_points_before":5,"action_points_after":2}}',
    ))).toEqual(entry('行动点 5→2'))
    expect(summarizeLog(entry(
      'Assistant::append_callback | SubTaskExtraInfo {"what":"BlackFlowRoutingDecision","details":{}}',
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

  it('derives readable or raw rows across the three content modes', () => {
    const readable = buildLogView(logs, { mode: 'readable', level: 'all', search: '', collapseRepeats: false })
    expect(readable.readable).toEqual([
      entry('重复消息'),
      entry('重复消息', 'INFO', '10:00:01'),
      entry('失败消息', 'ERROR', '10:00:04'),
    ])
    expect(readable.filtered).toHaveLength(3)
    expect(readable.visible).toHaveLength(3)

    // 详细模式行集与易读一致：未被改写的行不附带原始消息
    const detailed = buildLogView(logs, { mode: 'detailed', level: 'all', search: '', collapseRepeats: false })
    expect(detailed.readable).toEqual(readable.readable)
    expect(detailed.readable.every(log => log.raw === undefined)).toBe(true)

    const raw = buildLogView(logs, { mode: 'raw', level: 'all', search: '', collapseRepeats: false })
    expect(raw.readable).toHaveLength(5)
    expect(raw.filtered).toHaveLength(5)
    expect(raw.readable.every(log => log.raw === undefined)).toBe(true)
  })

  it('attaches raw only to rewritten rows in detailed mode', () => {
    const detailedLogs: LogEntry[] = [
      entry('普通消息'),
      entry('Assistant::append_callback | TaskChainStart {"taskchain":"Fight"}'),
    ]
    const detailed = buildLogView(detailedLogs, { mode: 'detailed', level: 'all', search: '', collapseRepeats: false })
    expect(detailed.readable).toEqual([
      entry('普通消息'),
      {
        ...entry('任务开始：作战（Fight）'),
        raw: 'Assistant::append_callback | TaskChainStart {"taskchain":"Fight"}',
      },
    ])
  })

  it('filters by level and case-insensitive search after summarizing', () => {
    const byLevel = buildLogView(logs, { mode: 'raw', level: 'ERROR', search: '', collapseRepeats: false })
    expect(byLevel.filtered).toEqual([entry('失败消息', 'ERROR', '10:00:04')])

    const bySearch = buildLogView(logs, { mode: 'raw', level: 'all', search: '  调试 ', collapseRepeats: false })
    expect(bySearch.filtered).toEqual([entry('调试消息', 'DEBUG')])

    const searchTime = buildLogView(logs, { mode: 'raw', level: 'all', search: '10:00:04', collapseRepeats: false })
    expect(searchTime.filtered).toEqual([entry('失败消息', 'ERROR', '10:00:04')])

    const readableLevel = buildLogView(logs, { mode: 'readable', level: 'DEBUG', search: '', collapseRepeats: false })
    expect(readableLevel.filtered).toEqual([])
  })

  it('collapses consecutive duplicates and keeps the latest time', () => {
    const collapsed = buildLogView(logs, { mode: 'readable', level: 'all', search: '', collapseRepeats: true })
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
    expect(buildLogView([], { mode: 'readable', level: 'all', search: '', collapseRepeats: true }))
      .toEqual({ readable: [], filtered: [], visible: [] })
  })
})

describe('filterLogsByRunId', () => {
  const runLogs: LogEntry[] = [
    { ...entry('本次执行'), runId: 'run-1', operationId: 'op-1' },
    { ...entry('另一次执行'), runId: 'run-2' },
    entry('没有归属的行'),
  ]

  it('keeps only the tracked run entries while a run is active', () => {
    expect(filterLogsByRunId(runLogs, 'run-1')).toEqual([
      { ...entry('本次执行'), runId: 'run-1', operationId: 'op-1' },
    ])
  })

  it('returns the same reference without an active run', () => {
    expect(filterLogsByRunId(runLogs, null)).toBe(runLogs)
    expect(filterLogsByRunId([], 'run-1')).toEqual([])
  })
})

describe('formatLogRawDetail', () => {
  it('pretty-prints the JSON part of callback lines', () => {
    expect(formatLogRawDetail('Assistant::append_callback | SubTaskExtraInfo  {"what":"RoguelikeEvent","details":{"name":"事件"}}'))
      .toBe([
        'SubTaskExtraInfo',
        '{',
        '  "what": "RoguelikeEvent",',
        '  "details": {',
        '    "name": "事件"',
        '  }',
        '}',
      ].join('\n'))
  })

  it('returns non-callback and malformed lines unchanged', () => {
    expect(formatLogRawDetail('stdout: 普通输出')).toBe('stdout: 普通输出')
    expect(formatLogRawDetail('Assistant::append_callback | TaskChainStart {not-json}'))
      .toBe('Assistant::append_callback | TaskChainStart {not-json}')
    expect(formatLogRawDetail('Assistant::append_callback | TaskChainStart'))
      .toBe('Assistant::append_callback | TaskChainStart')
  })
})

describe('buildLogContentFingerprint', () => {
  it('derives the fingerprint from row count and the last row time and message', () => {
    expect(buildLogContentFingerprint([entry('末行', 'INFO', '10:00:09')]))
      .toBe('1|10:00:09|末行')
    expect(buildLogContentFingerprint([
      entry('前一行', 'INFO', '10:00:08'),
      entry('末行', 'INFO', '10:00:09'),
    ])).toBe('2|10:00:09|末行')
  })

  it('keeps the fingerprint stable for identical content with fresh references', () => {
    const logs = [entry('重复消息', 'INFO', '10:00:00'), entry('末行', 'WARN', '10:00:01')]
    expect(buildLogContentFingerprint(logs.map(log => ({ ...log }))))
      .toBe(buildLogContentFingerprint(logs))
  })

  it('changes when rows are appended or the last row is replaced', () => {
    const logs = [entry('第一行', 'INFO', '10:00:00'), entry('末行', 'INFO', '10:00:01')]
    const appended = [...logs, entry('新增行', 'INFO', '10:00:02')]
    expect(buildLogContentFingerprint(appended)).not.toBe(buildLogContentFingerprint(logs))

    const rotated = [...logs.slice(1), entry('轮转行', 'INFO', '10:00:02')]
    expect(buildLogContentFingerprint(rotated)).not.toBe(buildLogContentFingerprint(logs))

    const retimed = [entry('第一行', 'INFO', '10:00:00'), entry('末行', 'INFO', '10:00:05')]
    expect(buildLogContentFingerprint(retimed)).not.toBe(buildLogContentFingerprint(logs))
  })

  it('represents empty logs with a stable fingerprint', () => {
    expect(buildLogContentFingerprint([])).toBe('0||')
  })
})
