/**
 * 日志解析、归一与展示纯模型
 *
 * 输入来自实时轮询数组或历史文件文本，输出统一的 `LogEntry`；摘要、级别/
 * 搜索过滤、run 过滤与重复折叠也在这里完成。MAA 回调行的语义摘要归
 * `logCallbackSummary.ts`，本模块组合它并处理其余生命周期行。本模块不依赖
 * React、网络或 DOM，页面只组合结果，因此可以直接对关键日志格式建立回归。
 */

import type { LogEntry } from '../types'
import { asRecord, getTaskName, summarizeCallback } from './logCallbackSummary'

export type LogFilter = 'all' | LogEntry['level']
/** 易读=语义与生命周期事件；详细=易读并附带可展开的原始内容；原始=原样输出。 */
export type LogContentMode = 'readable' | 'detailed' | 'raw'

export interface VisibleLog extends LogEntry {
  count: number
}

export interface LogViewOptions {
  readonly mode: LogContentMode
  readonly level: LogFilter
  readonly search: string
  readonly collapseRepeats: boolean
}

export interface LogView {
  /** 易读/详细模式下已丢弃无需关注的行；raw 模式保留全部。 */
  readonly readable: readonly LogEntry[]
  /** 应用级别与搜索条件后的行，用于导出。 */
  readonly filtered: readonly LogEntry[]
  /** 实际渲染的行；启用折叠时带重复次数。 */
  readonly visible: readonly VisibleLog[]
}

export const LOG_LEVELS: readonly LogEntry['level'][] = ['ERROR', 'WARN', 'INFO', 'DEBUG']

const LOG_LEVEL_ALIASES: Record<string, LogEntry['level']> = {
  ERR: 'ERROR',
  ERROR: 'ERROR',
  WRN: 'WARN',
  WARN: 'WARN',
  WARNING: 'WARN',
  INF: 'INFO',
  INFO: 'INFO',
  DBG: 'DEBUG',
  DEBUG: 'DEBUG',
  TRC: 'DEBUG',
  TRACE: 'DEBUG',
}

export function normalizeLevel(value: unknown): LogEntry['level'] {
  const rawLevel = String(value || '').toUpperCase()
  const level = LOG_LEVEL_ALIASES[rawLevel] || rawLevel as LogEntry['level']
  return LOG_LEVELS.includes(level) ? level : 'INFO'
}

export function formatLogTime(value: unknown): string {
  const date = new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return ''

  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => part.toString().padStart(2, '0'))
    .join(':')
}

/** 读取服务端执行上下文带来的 run 归属；缺失或非字符串字段不写入条目。 */
function readLogIdentity(log: Record<string, unknown>): Pick<LogEntry, 'runId' | 'operationId'> {
  const identity: Pick<LogEntry, 'runId' | 'operationId'> = {}
  if (typeof log.runId === 'string' && log.runId) identity.runId = log.runId
  if (typeof log.operationId === 'string' && log.operationId) identity.operationId = log.operationId
  return identity
}

export function parseRealtimeLog(value: unknown): LogEntry {
  const log = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const message = String(log.message ?? '')
  const identity = readLogIdentity(log)
  const parsedOutput = parseHistoryLine(message)
  if (parsedOutput.time) return { ...parsedOutput, ...identity }

  return {
    time: formatLogTime(log.time),
    level: normalizeLevel(log.level),
    message,
    ...identity,
  }
}

export function parseHistoryLine(line: string): LogEntry {
  const bracketedMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})(?:\.\d+)?)\]\[([A-Za-z]+)\](?:\[[^\]]*\])*\s*(.*)$/)
  if (bracketedMatch) {
    return {
      time: bracketedMatch[2] || '',
      level: normalizeLevel(bracketedMatch[3]),
      message: bracketedMatch[4] || line,
    }
  }

  const match = line.match(/\[(\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})) (\w+)\] (.+)/)
  if (!match) return { time: '', level: 'INFO', message: line }

  return {
    time: match[2] || '',
    level: normalizeLevel(match[3]),
    message: match[4] || line,
  }
}

export function parseHistoryContent(content: unknown): LogEntry[] {
  if (typeof content !== 'string') return []
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(parseHistoryLine)
}

export function summarizeLog(log: LogEntry): LogEntry | null {
  if (log.level === 'DEBUG' || !log.time) return null

  const callback = summarizeCallback(log)
  if (log.message.startsWith('Assistant::append_callback |')) return callback

  const message = log.message.trim()
  if (!message || /^[{}"]/.test(message) || message.startsWith('{')) return null

  if (/^执行命令:\s+maa\s+(?:dir log|activity\b)/.test(message)) return null

  const stateUpdate = message.match(/^任务状态更新:\s+(\{.*\})$/)
  if (stateUpdate) {
    try {
      const state = asRecord(JSON.parse(stateUpdate[1] || '{}'))
      return state.isRunning === true
        ? { ...log, message: `任务开始：${getTaskName(state.taskName || state.taskType)}` }
        : { ...log, message: '任务执行结束' }
    } catch {
      return null
    }
  }

  const commandStart = message.match(/^执行命令:\s+maa\s+(\w+)(?:\s+.*?)?,\s*等待完成:\s*(?:true|false)$/)
  if (commandStart) {
    const commandNames: Record<string, string> = {
      run: '自动化任务',
      startup: '启动游戏',
      fight: '理智作战',
      roguelike: '集成战略',
      copilot: '作业执行',
    }
    return { ...log, message: `开始执行：${commandNames[commandStart[1] || ''] || commandStart[1]}` }
  }

  const commandEnd = message.match(/^命令执行完成:\s+maa\s+(.+?),\s*退出码:\s*(-?\d+)$/)
  if (commandEnd) {
    const exitCode = Number(commandEnd[2])
    return {
      ...log,
      level: exitCode === 0 ? log.level : 'ERROR',
      message: exitCode === 0 ? 'MAA 命令执行完成' : `MAA 命令执行失败，退出码 ${exitCode}`,
    }
  }

  if (message.startsWith('临时任务文件已创建:')) return null
  if (message.startsWith('stdout:')) return { ...log, message: `MAA 输出：${message.slice(7).trim()}` }
  if (message.startsWith('stderr:')) return { ...log, level: 'WARN', message: `MAA 提示：${message.slice(7).trim()}` }

  const queuedTask = message.match(/^append_task\s+(\w+)\s*\{?$/)
  if (queuedTask) return { ...log, message: `任务已加入队列：${getTaskName(queuedTask[1])}` }

  if (message === 'Start | block') return { ...log, message: '任务执行开始' }
  if (message === 'Stop | block') return { ...log, message: '任务执行结束' }
  if (message.startsWith('timeout when waiting socket connection')) {
    return { ...log, level: 'WARN', message: '截图通道连接超时，正在切换备用方案' }
  }
  if (message.startsWith('Killing child `')) {
    return { ...log, level: 'ERROR', message: '已终止超时的截图进程' }
  }
  if (message.startsWith('Call `') && message.endsWith('failed')) {
    return { ...log, level: 'WARN', message: 'ADB 调用失败，正在尝试备用方案' }
  }
  if (message === 'data is empty!') {
    return { ...log, level: 'WARN', message: '截图数据为空，正在切换备用方案' }
  }

  const noisyInfo = /^(Call `|record path |load |already loaded |load ret |set_instance_option |append_task \| task_id|Candidate templates count:|Item id:|command server start |touch_program |pipe str|minitouch key props|adb -s |Try to find |Raw\w+ is not supported|screencap_end_of_line|Encode cost |The fastest way is )/
  if (log.level === 'INFO' && noisyInfo.test(message)) return null

  return { ...log, message }
}

export function collapseRepeatedLogs(logs: readonly LogEntry[]): VisibleLog[] {
  return logs.reduce<VisibleLog[]>((entries, log) => {
    const previous = entries[entries.length - 1]
    if (previous && previous.level === log.level && previous.message === log.message) {
      previous.count += 1
      previous.time = log.time || previous.time
    } else {
      entries.push({ ...log, count: 1 })
    }
    return entries
  }, [])
}

/**
 * 滚动跟随用的内容指纹：行数 + 末行时间 + 末行文本。
 * 快照每次轮询都会重建行数组，引用不可靠；只有该指纹变化才代表可见内容
 * 变化（快照只整体替换且按时间追加，行数与末行足以识别新增与轮转）。
 */
export function buildLogContentFingerprint(logs: readonly LogEntry[]): string {
  const last = logs[logs.length - 1]
  return `${logs.length}|${last?.time ?? ''}|${last?.message ?? ''}`
}

/**
 * 「只看本次执行」：有活动 run 时只保留该 run 的实时条目；没有活动 run
 * （runId 为 null）时不过滤，原样返回同一引用。
 */
export function filterLogsByRunId(
  logs: readonly LogEntry[],
  runId: string | null,
): readonly LogEntry[] {
  if (!runId) return logs
  return logs.filter(log => log.runId === runId)
}

/**
 * 详细模式的展开内容：回调行把 JSON 段格式化为缩进结构，其余原样返回；
 * JSON 非法时退回原始文本。
 */
export function formatLogRawDetail(raw: string): string {
  const marker = 'Assistant::append_callback | '
  if (!raw.startsWith(marker)) return raw
  const jsonStart = raw.indexOf('{', marker.length)
  if (jsonStart === -1) return raw
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as unknown
    return `${raw.slice(marker.length, jsonStart).trim()}\n${JSON.stringify(parsed, null, 2)}`
  } catch {
    return raw
  }
}

/**
 * 一次派生易读/详细/原始行、级别与搜索过滤，以及重复折叠后的渲染行。
 * 页面不再各自实现这三步，导出使用 `filtered`，渲染使用 `visible`。
 */
export function buildLogView(logs: readonly LogEntry[], options: LogViewOptions): LogView {
  const readable = options.mode === 'raw'
    ? logs
    : logs.flatMap(log => {
        const summarized = summarizeLog(log)
        if (!summarized) return []
        // 详细模式为被改写的行保留原始消息，供控制台展开查看。
        if (options.mode === 'detailed' && summarized.message !== log.message) {
          return [{ ...summarized, raw: log.message }]
        }
        return [summarized]
      })

  const query = options.search.trim().toLocaleLowerCase('zh-CN')
  const filtered = readable.filter(log => {
    const matchesLevel = options.level === 'all' || log.level === options.level
    const matchesSearch = !query
      || `${log.time} ${log.level} ${log.message}`.toLocaleLowerCase('zh-CN').includes(query)
    return matchesLevel && matchesSearch
  })

  const visible = options.collapseRepeats
    ? collapseRepeatedLogs(filtered)
    : filtered.map(log => ({ ...log, count: 1 }))

  return { readable, filtered, visible }
}
