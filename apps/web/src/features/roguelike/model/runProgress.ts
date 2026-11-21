import {
  isActiveRunState,
  isTerminalRunState,
  type AgentRun,
} from '@/features/task-execution'
import { readRoguelikeRunSummary, type RoguelikeRunSummary } from './runSummary'

export type RoguelikeCommand = 'roguelike' | 'reclamation'
export type RoguelikeRoundOutcome = 'passed' | 'not_passed' | 'unknown'
export type RoguelikeProgressPhase = 'starting' | 'exploring' | 'ended' | 'unknown'
export type RoguelikeLastEventKind = 'round' | 'combat' | 'event' | 'investment' | 'task'

export interface RoguelikeProgressRound {
  index: number | null
  outcome: RoguelikeRoundOutcome
  settled: boolean
  floor: number | null
  score: number | null
  endedAt: string | null
}

export interface RoguelikeProgressInvestment {
  rounds: number
  count: number
  total: number | null
  deposit: number | null
}

export interface RoguelikeProgressSnapshot {
  command: RoguelikeCommand
  theme: string
  mode: number | null
  phase: RoguelikeProgressPhase
  currentRound: number | null
  roundStartedAt: string | null
  targetRounds: number | null
  roundsStarted: number
  roundsEnded: number
  roundsSettled: number
  roundsPassed: number
  settlementSupported: boolean | null
  currentAction: string | null
  lastEventKind: RoguelikeLastEventKind | null
  lastEventName: string | null
  lastEventAt: string | null
  combatCount: number
  investment: RoguelikeProgressInvestment | null
  recentRounds: RoguelikeProgressRound[]
  updatedAt: string
  degraded: boolean
  observed: boolean
}

export interface RoguelikeProgressView {
  status: 'loading' | 'idle' | 'active' | 'terminal'
  command: RoguelikeCommand
  progress: RoguelikeProgressSnapshot | null
  run: AgentRun | null
  summary: RoguelikeRunSummary | null
  fromLastRun: boolean
  taskName: string | null
}

export interface RoguelikeProgressViewInput {
  mode: RoguelikeCommand
  run: AgentRun | null
  lastRun: AgentRun | null
  hasSnapshot: boolean
  taskName?: string | null
}

const COMMAND_SET: ReadonlySet<string> = new Set(['roguelike', 'reclamation'])
const PHASE_SET: ReadonlySet<string> = new Set(['starting', 'exploring', 'ended', 'unknown'])
const OUTCOME_SET: ReadonlySet<string> = new Set(['passed', 'not_passed', 'unknown'])
const LAST_EVENT_KIND_SET: ReadonlySet<string> = new Set(['round', 'combat', 'event', 'investment', 'task'])

const OUTCOME_LABELS: Record<RoguelikeRoundOutcome, string> = {
  passed: '通关',
  not_passed: '未通关',
  unknown: '未确认',
}

const MAX_RECENT_ROUNDS = 5
const JUST_NOW_MS = 5_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const readBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

const readText = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const readMode = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null

const isCommand = (value: unknown): value is RoguelikeCommand =>
  typeof value === 'string' && COMMAND_SET.has(value)

const readPhase = (value: unknown): RoguelikeProgressPhase =>
  typeof value === 'string' && PHASE_SET.has(value)
    ? value as RoguelikeProgressPhase
    : 'unknown'

const readOutcome = (value: unknown): RoguelikeRoundOutcome =>
  typeof value === 'string' && OUTCOME_SET.has(value)
    ? value as RoguelikeRoundOutcome
    : 'unknown'

const readLastEventKind = (value: unknown): RoguelikeLastEventKind | null =>
  typeof value === 'string' && LAST_EVENT_KIND_SET.has(value)
    ? value as RoguelikeLastEventKind
    : null

function parseRound(value: unknown): RoguelikeProgressRound | null {
  if (!isRecord(value)) return null
  const settled = readBoolean(value.settled)
  if (settled === null) return null
  return {
    index: readFiniteNumber(value.index),
    outcome: readOutcome(value.outcome),
    settled,
    floor: readFiniteNumber(value.floor),
    score: readFiniteNumber(value.score),
    endedAt: readText(value.endedAt),
  }
}

function readRecentRounds(value: unknown): RoguelikeProgressRound[] {
  if (!Array.isArray(value)) return []
  const rounds: RoguelikeProgressRound[] = []
  for (const entry of value) {
    const round = parseRound(entry)
    if (!round) continue
    rounds.push(round)
    if (rounds.length === MAX_RECENT_ROUNDS) break
  }
  return rounds
}

function parseInvestment(value: unknown): RoguelikeProgressInvestment | null {
  if (!isRecord(value)) return null
  const rounds = readFiniteNumber(value.rounds)
  const count = readFiniteNumber(value.count)
  if (rounds === null || count === null) return null
  return {
    rounds,
    count,
    total: readFiniteNumber(value.total),
    deposit: readFiniteNumber(value.deposit),
  }
}

function parseSnapshot(value: unknown): RoguelikeProgressSnapshot | null {
  if (!isRecord(value) || !isCommand(value.command)) return null

  const theme = readText(value.theme)
  const roundsStarted = readFiniteNumber(value.roundsStarted)
  const roundsEnded = readFiniteNumber(value.roundsEnded)
  const roundsSettled = readFiniteNumber(value.roundsSettled)
  const roundsPassed = readFiniteNumber(value.roundsPassed)
  const combatCount = readFiniteNumber(value.combatCount)
  const updatedAt = readText(value.updatedAt)
  const degraded = readBoolean(value.degraded)
  const observed = readBoolean(value.observed)
  if (
    theme === null
    || roundsStarted === null
    || roundsEnded === null
    || roundsSettled === null
    || roundsPassed === null
    || combatCount === null
    || updatedAt === null
    || degraded === null
    || observed === null
  ) {
    return null
  }

  return {
    command: value.command,
    theme,
    mode: readMode(value.mode),
    phase: readPhase(value.phase),
    currentRound: readFiniteNumber(value.currentRound),
    roundStartedAt: readText(value.roundStartedAt),
    targetRounds: readFiniteNumber(value.targetRounds),
    roundsStarted,
    roundsEnded,
    roundsSettled,
    roundsPassed,
    settlementSupported: readBoolean(value.settlementSupported),
    currentAction: readText(value.currentAction),
    lastEventKind: readLastEventKind(value.lastEventKind),
    lastEventName: readText(value.lastEventName),
    lastEventAt: readText(value.lastEventAt),
    combatCount,
    investment: parseInvestment(value.investment),
    recentRounds: readRecentRounds(value.recentRounds),
    updatedAt,
    degraded,
    observed,
  }
}

function readNestedProgress(container: unknown): unknown {
  if (!isRecord(container)) return undefined
  const summary = container.summary
  if (!isRecord(summary)) return undefined
  return summary.progress
}

export function readRoguelikeRunProgress(run: AgentRun | null): RoguelikeProgressSnapshot | null {
  if (!run) return null
  return parseSnapshot(run.progress?.roguelike)
}

export function readRoguelikeSummaryProgress(run: AgentRun | null): RoguelikeProgressSnapshot | null {
  if (!run) return null
  return parseSnapshot(readNestedProgress(run.result))
    ?? parseSnapshot(readNestedProgress(run.error?.details))
}

function createView(
  status: RoguelikeProgressView['status'],
  command: RoguelikeCommand,
  progress: RoguelikeProgressSnapshot | null,
  run: AgentRun | null,
  summary: RoguelikeRunSummary | null,
  fromLastRun: boolean,
  taskName: string | null,
): RoguelikeProgressView {
  return { status, command, progress, run, summary, fromLastRun, taskName }
}

function selectActiveRun(
  run: AgentRun,
  mode: RoguelikeCommand,
  taskName: string | null,
): RoguelikeProgressView | null {
  const progress = readRoguelikeRunProgress(run)
  if (!progress) return createView('active', mode, null, run, null, false, taskName)
  if (progress.command !== mode) return null
  return createView('active', mode, progress, run, null, false, taskName)
}

function selectTerminalRun(
  run: AgentRun,
  mode: RoguelikeCommand,
  taskName: string | null,
): RoguelikeProgressView | null {
  const progress = readRoguelikeSummaryProgress(run)
  const summary = readRoguelikeRunSummary(run)
  const progressCommand = progress?.command ?? null
  const summaryCommand = summary?.command ?? null

  if (progressCommand === null && summaryCommand === null) {
    return createView('terminal', mode, null, run, null, false, taskName)
  }
  if (progressCommand !== mode && summaryCommand !== mode) return null

  return createView(
    'terminal',
    mode,
    progressCommand === mode ? progress : null,
    run,
    summaryCommand === mode ? summary : null,
    false,
    taskName,
  )
}

function selectLastRun(
  lastRun: AgentRun | null,
  mode: RoguelikeCommand,
): RoguelikeProgressView | null {
  if (!lastRun || lastRun.operationId !== 'run_task') return null
  const summary = readRoguelikeRunSummary(lastRun)
  if (summary?.command !== mode) return null
  const progress = readRoguelikeSummaryProgress(lastRun)
  return createView(
    'terminal',
    mode,
    progress?.command === mode ? progress : null,
    lastRun,
    summary,
    true,
    null,
  )
}

export function selectRoguelikeProgressView({
  mode,
  run,
  lastRun,
  hasSnapshot,
  taskName = null,
}: RoguelikeProgressViewInput): RoguelikeProgressView {
  const name = taskName ?? null

  if (run && isActiveRunState(run.state)) {
    const active = selectActiveRun(run, mode, name)
    if (active) return active
  } else if (run && isTerminalRunState(run.state)) {
    const terminal = selectTerminalRun(run, mode, name)
    if (terminal) return terminal
  }

  const previous = selectLastRun(lastRun, mode)
  if (previous) return previous

  return createView(hasSnapshot ? 'idle' : 'loading', mode, null, null, null, false, name)
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

export function formatRoguelikeElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60)
    return `${hours}:${pad2(totalMinutes % 60)}:${pad2(seconds)}`
  }
  return `${pad2(totalMinutes)}:${pad2(seconds)}`
}

export function formatRoguelikeRelativeTime(atMs: number | null, nowMs: number): string | null {
  if (atMs === null || !Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null
  const elapsed = nowMs - atMs
  if (elapsed < 0) return null
  if (elapsed < JUST_NOW_MS) return '刚刚'
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / 1000)} 秒前`
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`
  return `${Math.floor(elapsed / HOUR_MS)} 小时前`
}

export function calculateRoguelikeSuccessRate(passed: number, ended: number): number | null {
  if (!Number.isFinite(passed) || !Number.isFinite(ended) || ended <= 0) return null
  return Math.round((passed / ended) * 100)
}

export function describeRoguelikeRoundOutcome(outcome: RoguelikeRoundOutcome): string {
  return OUTCOME_LABELS[outcome]
}
