import type { AgentRun } from '@/features/task-execution'

export type RoguelikeSummaryCommand = 'roguelike' | 'reclamation'
export type RoguelikeSummaryStatus = 'success' | 'failed' | 'stopped' | 'incomplete'
export type RoguelikeSummaryTone = 'success' | 'warning' | 'danger'

export interface RoguelikeSettlementSummary {
  gamePass: boolean | null
  floor: number | null
  step: number | null
  combat: number | null
  recruit: number | null
  collection: number | null
  boss: number | null
  emergency: number | null
  difficulty: number | null
  score: number | null
  exp: number | null
  skill: string | null
}

export interface RoguelikeInvestmentSummary {
  rounds: number
  count: number
  total: number | null
  deposit: number | null
  reachedLimit: boolean
  reachedFull: boolean
}

export interface RoguelikeEventSummary {
  name: string
  option: string | null
}

export interface RoguelikeCopperSummary {
  toDiscard: string
  toPickup: string
}

export interface RoguelikeStrategySummary {
  profile: string | null
  outcome: string | null
  succeeded: boolean | null
}

export interface RoguelikeTaskChainSummary {
  started: boolean
  completed: boolean
  failed: boolean
  stopped: boolean
}

export interface RoguelikeRunSummary {
  command: RoguelikeSummaryCommand
  theme: string
  status: RoguelikeSummaryStatus
  observed: boolean
  message: string
  settlement: RoguelikeSettlementSummary | null
  investment: RoguelikeInvestmentSummary | null
  events: RoguelikeEventSummary[]
  coppers: RoguelikeCopperSummary[]
  milestones: string[]
  warnings: string[]
  strategy: RoguelikeStrategySummary | null
  combats: number
  taskChain: RoguelikeTaskChainSummary
}

export interface RoguelikeSummaryMetric {
  label: string
  value: string
}

export interface RoguelikeRunSummaryDescription {
  statusLabel: string
  tone: RoguelikeSummaryTone
  metrics: RoguelikeSummaryMetric[]
  events: string[]
  notes: string[]
}

const COMMAND_SET: ReadonlySet<string> = new Set(['roguelike', 'reclamation'])
const STATUS_SET: ReadonlySet<string> = new Set(['success', 'failed', 'stopped', 'incomplete'])

const STATUS_LABELS: Record<RoguelikeSummaryStatus, string> = {
  success: '成功',
  failed: '失败',
  stopped: '已停止',
  incomplete: '未完成',
}

const STATUS_TONES: Record<RoguelikeSummaryStatus, RoguelikeSummaryTone> = {
  success: 'success',
  failed: 'danger',
  stopped: 'warning',
  incomplete: 'warning',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const parseNullableText = (value: unknown): string | null | undefined => {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

const parseNullableBoolean = (value: unknown): boolean | null | undefined => {
  if (value === null) return null
  return typeof value === 'boolean' ? value : undefined
}

const parseTextArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null

const parseSettlement = (value: unknown): RoguelikeSettlementSummary | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined

  const parsed = {
    gamePass: parseNullableBoolean(value.gamePass),
    floor: parseNullableNumber(value.floor),
    step: parseNullableNumber(value.step),
    combat: parseNullableNumber(value.combat),
    recruit: parseNullableNumber(value.recruit),
    collection: parseNullableNumber(value.collection),
    boss: parseNullableNumber(value.boss),
    emergency: parseNullableNumber(value.emergency),
    difficulty: parseNullableNumber(value.difficulty),
    score: parseNullableNumber(value.score),
    exp: parseNullableNumber(value.exp),
    skill: parseNullableText(value.skill),
  }
  if (Object.values(parsed).some(field => field === undefined)) return undefined
  return parsed as RoguelikeSettlementSummary
}

const parseInvestment = (value: unknown): RoguelikeInvestmentSummary | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (typeof value.rounds !== 'number' || !Number.isFinite(value.rounds)) return undefined
  if (typeof value.count !== 'number' || !Number.isFinite(value.count)) return undefined
  if (typeof value.reachedLimit !== 'boolean' || typeof value.reachedFull !== 'boolean') return undefined

  const total = parseNullableNumber(value.total)
  const deposit = parseNullableNumber(value.deposit)
  if (total === undefined || deposit === undefined) return undefined

  return {
    rounds: value.rounds,
    count: value.count,
    total,
    deposit,
    reachedLimit: value.reachedLimit,
    reachedFull: value.reachedFull,
  }
}

const parseEvents = (value: unknown): RoguelikeEventSummary[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const events: RoguelikeEventSummary[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string') return undefined
    const option = parseNullableText(item.option)
    if (option === undefined) return undefined
    events.push({ name: item.name, option })
  }
  return events
}

const parseCoppers = (value: unknown): RoguelikeCopperSummary[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const coppers: RoguelikeCopperSummary[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    if (typeof item.toDiscard !== 'string' || typeof item.toPickup !== 'string') return undefined
    coppers.push({ toDiscard: item.toDiscard, toPickup: item.toPickup })
  }
  return coppers
}

const parseStrategy = (value: unknown): RoguelikeStrategySummary | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const profile = parseNullableText(value.profile)
  const outcome = parseNullableText(value.outcome)
  const succeeded = parseNullableBoolean(value.succeeded)
  if (profile === undefined || outcome === undefined || succeeded === undefined) return undefined
  return { profile, outcome, succeeded }
}

const parseTaskChain = (value: unknown): RoguelikeTaskChainSummary | undefined => {
  if (!isRecord(value)) return undefined
  if (
    typeof value.started !== 'boolean'
    || typeof value.completed !== 'boolean'
    || typeof value.failed !== 'boolean'
    || typeof value.stopped !== 'boolean'
  ) {
    return undefined
  }
  return {
    started: value.started,
    completed: value.completed,
    failed: value.failed,
    stopped: value.stopped,
  }
}

const parseRunSummary = (value: unknown): RoguelikeRunSummary | null => {
  if (!isRecord(value)) return null
  if (typeof value.command !== 'string' || !COMMAND_SET.has(value.command)) return null
  if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) return null
  if (typeof value.theme !== 'string') return null
  if (typeof value.observed !== 'boolean') return null
  if (typeof value.message !== 'string') return null
  if (typeof value.combats !== 'number' || !Number.isFinite(value.combats)) return null

  const settlement = parseSettlement(value.settlement)
  const investment = parseInvestment(value.investment)
  const events = parseEvents(value.events)
  const coppers = parseCoppers(value.coppers)
  const milestones = parseTextArray(value.milestones)
  const warnings = parseTextArray(value.warnings)
  const strategy = parseStrategy(value.strategy)
  const taskChain = parseTaskChain(value.taskChain)
  if (
    settlement === undefined
    || investment === undefined
    || events === undefined
    || coppers === undefined
    || milestones === null
    || warnings === null
    || strategy === undefined
    || taskChain === undefined
  ) {
    return null
  }

  return {
    command: value.command as RoguelikeSummaryCommand,
    theme: value.theme,
    status: value.status as RoguelikeSummaryStatus,
    observed: value.observed,
    message: value.message,
    settlement,
    investment,
    events,
    coppers,
    milestones,
    warnings,
    strategy,
    combats: value.combats,
    taskChain,
  }
}

export function readRoguelikeRunSummary(run: AgentRun | null): RoguelikeRunSummary | null {
  if (!run) return null
  if (isRecord(run.result)) {
    const summary = parseRunSummary(run.result.summary)
    if (summary) return summary
  }
  const details = run.error?.details
  if (!isRecord(details)) return null
  return parseRunSummary(details.summary)
}

export function describeRoguelikeRunSummary(
  summary: RoguelikeRunSummary,
): RoguelikeRunSummaryDescription {
  const metrics: RoguelikeSummaryMetric[] = []
  const pushMetric = (label: string, value: string | number | null) => {
    if (value === null || value === '') return
    metrics.push({ label, value: String(value) })
  }

  pushMetric('主题', summary.theme)
  const settlement = summary.settlement
  if (settlement) {
    pushMetric('通关', settlement.gamePass === null ? null : settlement.gamePass ? '是' : '否')
    pushMetric('层数', settlement.floor)
    pushMetric('步数', settlement.step)
    pushMetric('作战', settlement.combat)
    pushMetric('招募', settlement.recruit)
    pushMetric('收藏品', settlement.collection)
    pushMetric('Boss', settlement.boss)
    pushMetric('紧急作战', settlement.emergency)
    pushMetric('难度', settlement.difficulty)
    pushMetric('得分', settlement.score)
    pushMetric('经验', settlement.exp)
    pushMetric('技能', settlement.skill)
  }
  const investment = summary.investment
  if (investment) {
    pushMetric('投资轮次', investment.rounds)
    pushMetric('投资次数', investment.count)
    pushMetric('投资总额', investment.total)
    pushMetric('投资存款', investment.deposit)
  }
  pushMetric('战斗次数', summary.combats)

  const events = summary.events.map(event =>
    event.option === null ? `${event.name}（未记录选项）` : `${event.name}：${event.option}`,
  )
  const notes: string[] = []
  summary.milestones.forEach(milestone => notes.push(`里程碑：${milestone}`))
  summary.warnings.forEach(warning => notes.push(`警告：${warning}`))
  summary.coppers.forEach(copper => {
    notes.push(`通宝交换：丢弃 ${copper.toDiscard}，拾取 ${copper.toPickup}`)
  })
  const strategy = summary.strategy
  if (strategy) {
    const outcome = strategy.outcome
      ?? (strategy.succeeded === null ? null : strategy.succeeded ? '成功' : '失败')
    const parts = [strategy.profile, outcome].filter((part): part is string => Boolean(part))
    if (parts.length > 0) notes.push(`策略：${parts.join(' · ')}`)
  }

  return {
    statusLabel: STATUS_LABELS[summary.status],
    tone: STATUS_TONES[summary.status],
    metrics,
    events,
    notes,
  }
}
