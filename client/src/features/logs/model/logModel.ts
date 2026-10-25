/**
 * 日志解析、归一与展示纯模型
 *
 * 输入来自实时轮询数组或历史文件文本，输出统一的 `LogEntry`；摘要、级别/
 * 搜索过滤与重复折叠也在这里完成。本模块不依赖 React、网络或 DOM，页面只
 * 组合结果，因此可以直接对关键日志格式建立回归。
 */

import type { LogEntry } from '../types'

export type LogFilter = 'all' | LogEntry['level']
export type LogContentMode = 'summary' | 'raw'

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
  /** summary 模式下已丢弃无需关注的行；raw 模式保留全部。 */
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

const TASK_NAMES: Record<string, string> = {
  StartUp: '启动游戏',
  CloseDown: '关闭游戏',
  Fight: '作战',
  Award: '领取奖励',
  Mall: '信用商店',
  Recruit: '自动公招',
  Infrast: '基建换班',
  Depot: '仓库识别',
  Roguelike: '集成战略',
  ReclamationAlgorithm: '生息演算',
  Copilot: '作业执行',
  SSSCopilot: '保全作业',
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

export function parseRealtimeLog(value: unknown): LogEntry {
  const log = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const message = String(log.message ?? '')
  const parsedOutput = parseHistoryLine(message)
  if (parsedOutput.time) return parsedOutput

  return {
    time: formatLogTime(log.time),
    level: normalizeLevel(log.level),
    message,
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

function getTaskName(value: unknown): string {
  const name = String(value || '').trim()
  return TASK_NAMES[name] || name.replace(/Task(?:Plugin)?$/, '') || '未知任务'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function summarizeCallback(log: LogEntry): LogEntry | null {
  const match = log.message.match(/^Assistant::append_callback \| (\w+)\s+(\{.*\})$/)
  if (!match) return null

  let payload: Record<string, unknown>
  try {
    payload = asRecord(JSON.parse(match[2] || '{}'))
  } catch {
    return log
  }

  const event = match[1]
  const details = asRecord(payload.details)
  const taskName = getTaskName(payload.taskchain || payload.subtask || payload.class)

  switch (event) {
    case 'TaskChainStart':
      return { ...log, message: `任务开始：${taskName}` }
    case 'TaskChainCompleted':
      return { ...log, message: `任务完成：${taskName}` }
    case 'TaskChainError':
      return { ...log, level: 'ERROR', message: `任务失败：${taskName}` }
    case 'SubTaskError':
      return { ...log, level: 'ERROR', message: `执行步骤失败：${taskName}` }
    case 'AllTasksCompleted':
    case 'SubTaskStart':
    case 'SubTaskCompleted':
      return null
    case 'SubTaskExtraInfo':
      return payload.what === 'DepotInfo'
        ? { ...log, message: '仓库识别数据已生成' }
        : null
    case 'AsyncCallInfo':
      if (payload.what !== 'Connect') return null
      return {
        ...log,
        message: details.ret === true
          ? `设备连接完成${details.cost ? `，耗时 ${details.cost} ms` : ''}`
          : '设备连接失败',
        level: details.ret === true ? log.level : 'ERROR',
      }
    case 'ConnectionInfo':
      switch (payload.what) {
        case 'Connected':
          return { ...log, message: `设备连接成功${details.address ? `：${details.address}` : ''}` }
        case 'ResolutionGot':
        case 'ResolutionInfo':
          return details.width && details.height
            ? { ...log, message: `设备分辨率：${details.width} x ${details.height}` }
            : null
        case 'FastestWayToScreencap':
          return details.method
            ? { ...log, message: `已选择截图方式：${details.method}${details.cost ? `（${details.cost} ms）` : ''}` }
            : null
        default:
          return null
      }
    default:
      return null
  }
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
 * 一次派生摘要/原始行、级别与搜索过滤，以及重复折叠后的渲染行。
 * 页面不再各自实现这三步，导出使用 `filtered`，渲染使用 `visible`。
 */
export function buildLogView(logs: readonly LogEntry[], options: LogViewOptions): LogView {
  const readable = options.mode === 'raw'
    ? logs
    : logs.flatMap(log => {
        const summarized = summarizeLog(log)
        return summarized ? [summarized] : []
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
