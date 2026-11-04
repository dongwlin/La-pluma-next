import type { LogEntry } from '../types'

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

/** 读取 MAA taskchain/task 的展示名；未知名称去掉 Task/TaskPlugin 后缀。 */
export function getTaskName(value: unknown): string {
  const name = String(value || '').trim()
  return TASK_NAMES[name] || name.replace(/Task(?:Plugin)?$/, '') || '未知任务'
}

/** 收窄未知载荷为对象；数组、标量与 null 一律按空对象处理。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readTextField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function summarizeStageClear(log: LogEntry, marker: unknown): LogEntry | null {
  switch (marker) {
    case 'StageDrops-Stars-3':
      return { ...log, message: '三星通关' }
    case 'StageDrops-Adverse':
    case 'StageDrops-Stars-Adverse':
      return { ...log, message: '险情通关' }
    default:
      return null
  }
}

function summarizeCopilotFileLoad(log: LogEntry, details: Record<string, unknown>): LogEntry {
  const stageName = readTextField(details, 'stage_name')
  const fileName = readTextField(details, 'file_name')
  if (stageName && fileName) return { ...log, message: `开始作业：${stageName}（${fileName}）` }
  if (stageName) return { ...log, message: `开始作业：${stageName}` }
  if (fileName) return { ...log, message: `开始作业：${fileName}` }
  return { ...log, message: '开始加载作业文件' }
}

function summarizeCopilotAction(log: LogEntry, details: Record<string, unknown>): LogEntry {
  const target = readTextField(details, 'target')
  const elapsed = readNumberField(details, 'elapsed_time')
  if (target && elapsed !== null) return { ...log, message: `战斗进行中：${target} · 已用 ${elapsed}ms` }
  if (target) return { ...log, message: `战斗进行中：${target}` }
  if (elapsed !== null) return { ...log, message: `战斗进行中 · 已用 ${elapsed}ms` }
  return { ...log, message: '战斗进行中' }
}

function summarizeStageDrops(log: LogEntry, details: Record<string, unknown>): LogEntry | null {
  const drops = Array.isArray(details.drops) ? details.drops : []
  const parts: string[] = []
  for (const item of drops) {
    const record = asRecord(item)
    const name = readTextField(record, 'itemName')
    if (!name) continue
    const quantity = readNumberField(record, 'quantity')
    parts.push(quantity !== null ? `${name} ×${quantity}` : name)
  }
  return parts.length > 0 ? { ...log, message: `掉落：${parts.join('、')}` } : null
}

function summarizeRoguelikeSettlement(log: LogEntry, details: Record<string, unknown>): LogEntry {
  const floor = readNumberField(details, 'floor')
  const step = readNumberField(details, 'step')
  const recruit = readNumberField(details, 'recruit')
  const score = readNumberField(details, 'score')
  const progress = [
    floor !== null ? `${floor}层` : null,
    step !== null ? `${step}步` : null,
  ].filter(Boolean).join(' ')

  const parts = [
    progress || null,
    recruit !== null ? `招募 ${recruit}` : null,
    score !== null ? `得分 ${score}` : null,
  ].filter(Boolean)
  return { ...log, message: parts.length > 0 ? `肉鸽结算：${parts.join(' · ')}` : '肉鸽结算完成' }
}

function summarizeBlackFlowRouting(
  log: LogEntry,
  details: Record<string, unknown>,
): LogEntry | null {
  const parts: string[] = []
  const floor = readNumberField(details, 'floor')
  if (floor !== null) parts.push(`第 ${floor} 层`)
  const before = readNumberField(details, 'action_points_before')
  const after = readNumberField(details, 'action_points_after')
  if (before !== null && after !== null) parts.push(`行动点 ${before}→${after}`)
  const nodeName = readTextField(details, 'node_name')
  if (nodeName) parts.push(nodeName)
  return parts.length > 0 ? { ...log, message: parts.join(' · ') } : null
}

function summarizeRoguelikeInvestment(log: LogEntry, details: Record<string, unknown>): LogEntry {
  const count = readNumberField(details, 'count')
  const deposit = readNumberField(details, 'deposit')
  const depositText = deposit !== null && deposit >= 0 ? `（存款 ${deposit}）` : ''
  if (count !== null && count >= 0) return { ...log, message: `投资：${count}${depositText}` }
  if (depositText) return { ...log, message: `投资完成${depositText}` }
  return { ...log, message: '投资完成' }
}

/**
 * 把一条 MaaCore 回调行改写成可读摘要：
 * - 返回 `null` 表示无需展示（常规子任务开始/结束等噪音）；
 * - JSON 非法时原样保留该行，交给详情兜底。
 */
export function summarizeCallback(log: LogEntry): LogEntry | null {
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
  const taskIdentity = readTextField(payload, 'taskchain')
    ?? readTextField(payload, 'subtask')
    ?? readTextField(payload, 'class')
  if (['TaskChainStart', 'TaskChainCompleted', 'TaskChainError', 'SubTaskError'].includes(event || '') && !taskIdentity) {
    return { ...log, level: event?.endsWith('Error') ? 'ERROR' : log.level }
  }

  switch (event) {
    case 'TaskChainStart': {
      // 保留 taskchain 细节：译文与原始 id 不同时把原始 id 附在括号里。
      const rawTaskchain = readTextField(payload, 'taskchain')
        ?? readTextField(payload, 'subtask')
        ?? readTextField(payload, 'class')
      return rawTaskchain && rawTaskchain !== taskName
        ? { ...log, message: `任务开始：${taskName}（${rawTaskchain}）` }
        : { ...log, message: `任务开始：${taskName}` }
    }
    case 'TaskChainCompleted':
      return { ...log, message: `任务完成：${taskName}` }
    case 'TaskChainError':
      return { ...log, level: 'ERROR', message: `任务失败：${taskName}` }
    case 'SubTaskError':
      return { ...log, level: 'ERROR', message: `执行步骤失败：${taskName}` }
    case 'SubTaskStart':
      return summarizeStageClear(log, details.task)
        ?? (typeof details.task === 'string' && details.task.endsWith('FightMissionFailed')
          ? { ...log, level: 'ERROR', message: '作战失败' }
          : null)
    case 'AllTasksCompleted':
    case 'SubTaskCompleted':
      return null
    case 'SubTaskExtraInfo': {
      const stageClear = summarizeStageClear(log, payload.what)
      if (stageClear) return stageClear
      switch (payload.what) {
        case 'DepotInfo':
          return { ...log, message: '仓库识别数据已生成' }
        case 'CopilotListLoadTaskFileSuccess':
          return summarizeCopilotFileLoad(log, details)
        case 'CopilotAction':
          return summarizeCopilotAction(log, details)
        case 'StageDrops':
          return summarizeStageDrops(log, details)
        case 'RoguelikeSettlement':
          return summarizeRoguelikeSettlement(log, details)
        case 'BlackFlowRoutingDecision':
          return summarizeBlackFlowRouting(log, details)
        case 'RoguelikeInvestment':
          return summarizeRoguelikeInvestment(log, details)
        case 'RoguelikeEvent': {
          const eventName = readTextField(details, 'name')
          return eventName ? { ...log, message: `事件：${eventName}` } : null
        }
        default:
          return null
      }
    }
    case 'AsyncCallInfo':
      if (payload.what !== 'Connect') return null
      if (typeof details.ret !== 'boolean') return log
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
