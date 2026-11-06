import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import {
  completeAgentRun,
  getAgentRun,
  markAgentRunWaiting,
  setAgentRunAcceptedResult,
  startAgentRunForExecution,
  stopAgentRun
} from './agentRunService.ts';
import type { AgentRunDto, AgentRunStatus } from './agentRunService.ts';
import { buildCopilotPlan, executeCopilotEntries } from './copilotPlanService.ts';
import type {
  CopilotDelegationReport,
  CopilotEntriesOutcome,
  CopilotEntryOutcomeStatus,
  CopilotExecutionEntry,
  CopilotExecutionLifecycle,
  CopilotExecutionOptions,
  CopilotPlan,
  CopilotPlanEntry,
  CopilotTaskResult,
  ExecuteCopilotEntriesInput
} from './copilotPlanService.ts';

const TERMINAL_RUN_STATES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'succeeded',
  'failed',
  'stopped',
  'interrupted'
]);

export type CopilotSetMode = 'continuous' | 'manual';

export type CopilotSetSessionPhase = 'starting' | 'running' | 'waiting' | 'finished' | 'stopped';

/**
 * 条目状态：`running` 是会话内的执行阶段，结算后收敛到执行结果状态；
 * `skipped` 表示计划中未选中且此前未完成、本次集合明确不执行的条目。
 */
export type CopilotSetEntryStatus = 'running' | 'skipped' | CopilotEntryOutcomeStatus;

export interface CopilotSetEntryState {
  status: CopilotSetEntryStatus;
  error?: string;
}

export interface CopilotSetTaskResult extends Omit<CopilotTaskResult, 'status'> {
  status: CopilotSetEntryStatus;
}

export interface CopilotSetSummaryError {
  key: string;
  stage: string;
  error?: string;
}

/**
 * 一次集合执行的逐项汇总。三个条目总数各自独立，不靠差额互相推导：
 * - `plannedEntries` 是计划中的全部执行条目（含历史已完成）；
 * - `queuedEntries` 是本次执行队列（计划未完成且被选中）的条目数；
 * - `totalEntries` 是本汇总实际列出的条目数，恒等于 `taskResults.length`，
 *   即本次执行队列加上本次跳过（计划中未选中且此前未完成）的条目。
 */
export interface CopilotSetSummary {
  setId: string;
  name: string;
  mode: CopilotSetMode;
  raid: unknown;
  plannedEntries: number;
  queuedEntries: number;
  totalEntries: number;
  attemptedCount: number;
  alreadyCompletedCount: number;
  successCount: number;
  failedCount: number;
  stoppedCount: number;
  skippedCount: number;
  pendingCount: number;
  durationMs: number;
  errors: CopilotSetSummaryError[];
  taskResults: CopilotSetTaskResult[];
  /** 原生委托报告；只在本次执行尝试过原生路径时出现。 */
  delegation?: CopilotDelegationReport;
}

/** 旧字段兼容投影：已结算条目平铺 `success`/`error`/`stopped`。 */
export interface CopilotSetEntryResult extends CopilotPlanEntry {
  success: boolean;
  error?: string;
  stopped?: boolean;
}

export interface CopilotSetRunResult {
  success: true;
  stopped: boolean;
  finished: boolean;
  waitingForNext: boolean;
  nextEntry?: CopilotPlanEntry;
  mode: CopilotSetMode;
  setId: string;
  name: string;
  raid: unknown;
  message: string;
  plan: CopilotPlan;
  completed: string[];
  pending: CopilotPlanEntry[];
  results: CopilotSetEntryResult[];
  summary: CopilotSetSummary;
}

export interface CopilotSetWaitingOutcome {
  waitingForNext: boolean;
  finished: boolean;
  nextEntry?: CopilotPlanEntry;
  result: CopilotSetRunResult;
}

export interface CopilotSetStoppedOutcome {
  stopped: true;
  finished: true;
  result: CopilotSetRunResult;
}

export type CopilotSetManualOutcome = CopilotSetWaitingOutcome | CopilotSetStoppedOutcome;

/** 会话进度投影：只在会话仍存在时返回，不落盘。 */
export type CopilotSetProgressPhase = 'starting' | 'waiting_for_next' | 'running' | 'finished' | 'stopped';

export interface CopilotSetProgress {
  setId: string;
  name: string;
  mode: CopilotSetMode;
  phase: CopilotSetProgressPhase;
  currentStep: number;
  totalSteps: number;
  currentTask: string | null;
  currentEntry: CopilotPlanEntry | null;
  nextEntry: CopilotPlanEntry | null;
  shouldStop: boolean;
  successCount: number;
  failedCount: number;
  stoppedCount: number;
  skippedCount: number;
  pendingCount: number;
  message: string;
  taskResults: CopilotSetTaskResult[];
}

/** 按 runId 停止时的处理方式；不是 Run 状态。 */
export type CopilotSetStopDisposition = 'stopped' | 'canceled' | 'running' | 'terminal';

export interface CopilotSetStopOutcome {
  disposition: CopilotSetStopDisposition;
  run: AgentRunDto;
}

export interface CopilotSetPreparedInfo {
  setId: string;
  name: string;
  mode: CopilotSetMode;
  totalEntries: number;
  alreadyCompletedCount: number;
  selectedCount: number;
}

export interface CopilotSetLifecycle extends CopilotExecutionLifecycle {
  onPrepared?: (info: CopilotSetPreparedInfo) => void;
}

export interface CopilotSetRunInput {
  runId: string;
  setId: string | number;
  raid?: unknown;
  selectedIndexes?: readonly (string | number)[];
  options?: CopilotExecutionOptions;
  lifecycle?: CopilotSetLifecycle;
}

export interface ContinueCopilotSetInput {
  runId: string;
  lifecycle?: CopilotSetLifecycle;
}

export interface CopilotSetSession {
  runId: string;
  setId: string;
  name: string;
  mode: CopilotSetMode;
  raid: unknown;
  options: CopilotExecutionOptions;
  plan: CopilotPlan;
  scope: CopilotPlanEntry[];
  queue: CopilotPlanEntry[];
  completed: Set<string>;
  alreadyCompletedCount: number;
  results: Map<string, CopilotSetEntryState>;
  delegation: CopilotDelegationReport | null;
  stopRequested: boolean;
  attempting: boolean;
  phase: CopilotSetSessionPhase;
  currentEntry: CopilotPlanEntry | null;
  startedAt: number;
}

export interface CopilotSetRuntime {
  buildCopilotPlan(setId: string | number, raid?: unknown): Promise<CopilotPlan>;
  executeCopilotEntries(input: ExecuteCopilotEntriesInput): Promise<CopilotEntriesOutcome>;
  getAgentRun(runId: string): AgentRunDto | null;
  markAgentRunWaiting(runId: string): AgentRunDto;
  completeAgentRun(runId: string, result?: unknown): AgentRunDto;
  setAgentRunAcceptedResult(runId: string, result?: unknown): AgentRunDto;
  startAgentRunForExecution(runId: string): AgentRunDto;
  stopAgentRun(runId: string, result?: unknown): AgentRunDto;
}

/**
 * Server-held copilot-set sessions. A continuous set owns one Run for the
 * whole queue. A manual set owns one Run while it waits for the user between
 * entries; the waiting run holds no execution lease.
 */
const sessions = new Map<string, CopilotSetSession>();

const defaultRuntime: CopilotSetRuntime = {
  buildCopilotPlan,
  executeCopilotEntries,
  getAgentRun,
  markAgentRunWaiting,
  completeAgentRun,
  setAgentRunAcceptedResult,
  startAgentRunForExecution,
  stopAgentRun
};
let runtime: CopilotSetRuntime = defaultRuntime;

export function configureCopilotSetRuntimeForTests(overrides: Partial<CopilotSetRuntime> = {}): void {
  runtime = { ...defaultRuntime, ...overrides };
}

export function resetCopilotSetRunStateForTests(): void {
  sessions.clear();
  runtime = defaultRuntime;
}

export function hasCopilotSetSession(runId: string): boolean {
  return sessions.has(runId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field ? field : undefined;
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function readRecordField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function describeError(error: unknown): string {
  return readOptionalString(error, 'message') || String(error);
}

function copilotSetUnavailableError(setId: string | number, error: unknown): AgentError {
  return agentError('AGENT_COPILOT_SET_UNAVAILABLE', `作业集计划获取失败: ${describeError(error)}`, {
    statusCode: 502,
    details: { setId },
    retryable: true
  });
}

function copilotSetNotWaitingError(runId: string, state: string): AgentError {
  return agentError(
    'AGENT_COPILOT_SET_NOT_WAITING',
    `作业集当前不处于等待下一关状态（${state}）`,
    {
      statusCode: 409,
      details: { runId, state },
      retryable: state === 'accepted' || state === 'running' || state === 'stopping'
    }
  );
}

function sessionLostError(runId: string): AgentError {
  return agentError('AGENT_COPILOT_SET_SESSION_LOST', '作业集会话已失效，无法继续下一关', {
    statusCode: 409,
    details: { runId },
    retryable: false
  });
}

function createSession({
  runId,
  plan,
  mode,
  raid,
  options,
  selectedIndexes
}: {
  runId: string;
  plan: CopilotPlan;
  mode: CopilotSetMode;
  raid: unknown;
  options: CopilotExecutionOptions;
  selectedIndexes: readonly (string | number)[];
}): CopilotSetSession {
  const selected = new Set(selectedIndexes.map(Number));
  const scope = plan.entries.filter(entry => selected.size === 0 || selected.has(entry.itemIndex));
  const alreadyCompleted = scope.filter(entry => entry.completed);
  const queue = scope.filter(entry => !entry.completed);
  return {
    runId,
    setId: plan.setId,
    name: plan.name,
    mode,
    raid,
    options,
    plan,
    scope,
    queue,
    completed: new Set(alreadyCompleted.map(entry => entry.key)),
    alreadyCompletedCount: alreadyCompleted.length,
    results: new Map(queue.map(entry => [entry.key, { status: 'pending' }])),
    delegation: null,
    stopRequested: false,
    attempting: false,
    phase: 'starting',
    currentEntry: null,
    startedAt: Date.now()
  };
}

function describePrepared(session: CopilotSetSession): CopilotSetPreparedInfo {
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    totalEntries: session.queue.length,
    alreadyCompletedCount: session.alreadyCompletedCount,
    selectedCount: session.scope.length
  };
}

function statusOf(session: CopilotSetSession, entry: CopilotPlanEntry): CopilotSetEntryStatus {
  return session.results.get(entry.key)?.status || 'pending';
}

function isStopping(runId: string): boolean {
  const run = runtime.getAgentRun(runId);
  return !run || run.state === 'stopping' || TERMINAL_RUN_STATES.has(run.state);
}

function mergeOutcome(session: CopilotSetSession, outcome: CopilotEntriesOutcome): void {
  if (outcome.delegation?.attempted) session.delegation = outcome.delegation;
  for (const key of outcome.completed) session.completed.add(key);
  for (const result of outcome.summary.taskResults) {
    session.results.set(result.key, { status: result.status, error: result.error });
  }
}

function attemptedTaskResults(session: CopilotSetSession): CopilotSetTaskResult[] {
  return session.queue.map(entry => {
    const settled: CopilotSetEntryState = session.results.get(entry.key) || { status: 'pending' };
    return {
      key: entry.key,
      itemIndex: entry.itemIndex,
      copilotId: entry.copilotId,
      stageId: entry.stageId,
      stage: entry.displayStage,
      displayStage: entry.displayStage,
      apCost: entry.apCost,
      mode: entry.mode,
      presetFormation: Boolean(entry.presetFormation),
      status: settled.status,
      ...(settled.error ? { error: settled.error } : {})
    };
  });
}

function skippedEntriesOf(session: CopilotSetSession): CopilotPlanEntry[] {
  const scopedKeys = new Set(session.scope.map(entry => entry.key));
  return session.plan.entries.filter(entry => !entry.completed && !scopedKeys.has(entry.key));
}

function skippedTaskResults(session: CopilotSetSession): CopilotSetTaskResult[] {
  return skippedEntriesOf(session).map(entry => ({
    key: entry.key,
    itemIndex: entry.itemIndex,
    copilotId: entry.copilotId,
    stageId: entry.stageId,
    stage: entry.displayStage,
    displayStage: entry.displayStage,
    apCost: entry.apCost,
    mode: entry.mode,
    presetFormation: Boolean(entry.presetFormation),
    status: 'skipped' as const
  }));
}

function buildTaskResults(session: CopilotSetSession): CopilotSetTaskResult[] {
  return [...attemptedTaskResults(session), ...skippedTaskResults(session)];
}

function buildSummary(session: CopilotSetSession): CopilotSetSummary {
  const attempted = attemptedTaskResults(session);
  const taskResults = buildTaskResults(session);
  const count = (status: CopilotSetEntryStatus) =>
    taskResults.filter(result => result.status === status).length;
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    raid: session.raid,
    plannedEntries: session.plan.entries.length,
    queuedEntries: attempted.length,
    totalEntries: taskResults.length,
    attemptedCount: attempted.length - count('pending'),
    alreadyCompletedCount: session.alreadyCompletedCount,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    skippedCount: count('skipped'),
    pendingCount: count('pending'),
    durationMs: Date.now() - session.startedAt,
    errors: taskResults
      .filter(result => result.status === 'failed')
      .map(result => ({ key: result.key, stage: result.displayStage, error: result.error })),
    taskResults,
    ...(session.delegation ? { delegation: session.delegation } : {})
  };
}

function buildLegacyExtras(session: CopilotSetSession): {
  completed: string[];
  pending: CopilotPlanEntry[];
  results: CopilotSetEntryResult[];
} {
  const results = session.queue
    .filter(entry => statusOf(session, entry) !== 'pending')
    .map(entry => {
      const settled = session.results.get(entry.key);
      return {
        ...entry,
        success: settled?.status === 'success',
        ...(settled?.error ? { error: settled.error } : {}),
        ...(settled?.status === 'stopped' ? { stopped: true } : {})
      };
    });
  return {
    completed: [...session.completed],
    pending: session.scope.filter(entry => !session.completed.has(entry.key)),
    results
  };
}

function nextPendingEntry(session: CopilotSetSession): CopilotPlanEntry | null {
  return session.queue.find(entry => statusOf(session, entry) === 'pending') || null;
}

function buildRunResult(
  session: CopilotSetSession,
  { stopped = false, finished = false, waitingForNext = false, message }: {
    stopped?: boolean;
    finished?: boolean;
    waitingForNext?: boolean;
    message?: string;
  } = {}
): CopilotSetRunResult {
  const pendingEntry = waitingForNext ? nextPendingEntry(session) : null;
  return {
    success: true,
    stopped,
    finished,
    waitingForNext,
    ...(pendingEntry ? { nextEntry: pendingEntry } : {}),
    mode: session.mode,
    setId: session.setId,
    name: session.name,
    raid: session.raid,
    message: message || (waitingForNext ? '等待开始下一关' : '作业集执行完成'),
    plan: session.plan,
    ...buildLegacyExtras(session),
    summary: buildSummary(session)
  };
}

/**
 * 共享生命周期签名接受更宽的条目类型（活动执行复用）；集合会话只会通过
 * `executeCopilotEntries` 收到自己传入的 `CopilotPlanEntry`。
 */
function planEntryOf(entry: CopilotExecutionEntry): CopilotPlanEntry {
  return entry as CopilotPlanEntry;
}

function createSessionLifecycle(
  session: CopilotSetSession,
  lifecycle: CopilotSetLifecycle
): CopilotExecutionLifecycle {
  return {
    ...lifecycle,
    // The gate runs inside the lease, before any device side effect. It is
    // idempotent, so the tracked-action gate and this one can both run.
    onBeforeStart: async () => {
      await lifecycle.onBeforeStart?.();
      runtime.startAgentRunForExecution(session.runId);
    },
    shouldStop: async () => session.stopRequested
      || Boolean(await lifecycle.shouldStop?.())
      || isStopping(session.runId),
    onEntryStarted: (entry, entries = [entry]) => {
      session.phase = 'running';
      session.currentEntry = planEntryOf(entry);
      for (const item of entries) session.results.set(planEntryOf(item).key, { status: 'running' });
    },
    onEntrySettled: (entry, status, error) => {
      session.results.set(planEntryOf(entry).key, { status, error });
      if (status === 'success') session.completed.add(planEntryOf(entry).key);
    }
  };
}

async function prepareSession({
  runId,
  setId,
  raid,
  selectedIndexes,
  options,
  mode
}: {
  runId: string;
  setId: string | number;
  raid: unknown;
  selectedIndexes: readonly (string | number)[];
  options: CopilotExecutionOptions;
  mode: CopilotSetMode;
}): Promise<CopilotSetSession> {
  let plan: CopilotPlan;
  try {
    plan = await runtime.buildCopilotPlan(setId, raid);
  } catch (error) {
    throw copilotSetUnavailableError(setId, error);
  }
  const session = createSession({ runId, plan, mode, raid, options, selectedIndexes });
  sessions.set(runId, session);
  return session;
}

function copilotSetExecutionError(session: CopilotSetSession, outcome: CopilotEntriesOutcome): Error {
  const summary = outcome.summary || buildSummary(session);
  const failedCount = summary.failedCount || 0;
  const message = readOptionalString(outcome.error, 'message')
    || (failedCount ? `作业集执行失败，${failedCount} 项未完成` : '作业集执行失败');
  const error = new Error(message, { cause: outcome.error });
  Object.assign(error, {
    code: readOptionalString(outcome.error, 'code') || 'COPILOT_PLAN_FAILED',
    statusCode: readOptionalNumber(outcome.error, 'statusCode') || 422,
    details: {
      ...readRecordField(outcome.error, 'details'),
      setId: session.setId,
      mode: session.mode,
      plan: session.plan,
      results: outcome.results || [],
      completed: [...session.completed],
      summary,
      stopped: false
    },
    retryable: true
  });
  return error;
}

function normalizeRunningEntries(session: CopilotSetSession, message: string): void {
  for (const [key, settled] of session.results) {
    if (settled.status !== 'running') continue;
    session.results.set(key, { status: 'stopped', error: message });
  }
}

function finishStoppedSession(session: CopilotSetSession, message?: string): CopilotSetStoppedOutcome {
  session.stopRequested = true;
  session.phase = 'stopped';
  session.currentEntry = null;
  normalizeRunningEntries(session, message || '作业集已被终止');
  const result = buildRunResult(session, { stopped: true, finished: true, message: message || '作业集已被终止' });
  sessions.delete(session.runId);
  const run = runtime.getAgentRun(session.runId);
  if (run && !TERMINAL_RUN_STATES.has(run.state) && run.state !== 'stopped') {
    runtime.stopAgentRun(session.runId, result);
  }
  return { stopped: true, finished: true, result };
}

function settleManualQueue(session: CopilotSetSession): CopilotSetManualOutcome {
  if (session.stopRequested || isStopping(session.runId)) {
    return finishStoppedSession(session, '作业集已被终止');
  }

  const pendingEntry = nextPendingEntry(session);
  if (pendingEntry) {
    const run = runtime.getAgentRun(session.runId);
    if (!run || run.state !== 'running') return finishStoppedSession(session, '作业集已被终止');

    runtime.markAgentRunWaiting(session.runId);
    session.phase = 'waiting';
    session.currentEntry = null;
    const result = buildRunResult(session, {
      waitingForNext: true,
      message: '作业已完成，等待开始下一关'
    });
    runtime.setAgentRunAcceptedResult(session.runId, result);
    return { waitingForNext: true, finished: false, nextEntry: pendingEntry, result };
  }

  const summary = buildSummary(session);
  const message = summary.failedCount
    ? `作业集执行完成，${summary.failedCount} 项失败`
    : '作业集执行完成';
  const result = buildRunResult(session, { finished: true, message });
  runtime.completeAgentRun(session.runId, result);
  session.phase = 'finished';
  session.currentEntry = null;
  sessions.delete(session.runId);
  return { waitingForNext: false, finished: true, result };
}

async function runManualAttempt(
  session: CopilotSetSession,
  lifecycle: CopilotSetLifecycle,
  { initial }: { initial: boolean }
): Promise<CopilotSetManualOutcome> {
  const expectedState = initial ? 'accepted' : 'waiting';
  const run = runtime.getAgentRun(session.runId);
  if (!run || run.state !== expectedState) {
    throw copilotSetNotWaitingError(session.runId, run?.state || 'unknown');
  }

  const entry = nextPendingEntry(session);
  if (!entry) return settleManualQueue(session);
  if (session.attempting) {
    throw copilotSetNotWaitingError(session.runId, 'running');
  }

  session.attempting = true;
  session.phase = 'starting';
  session.currentEntry = entry;
  try {
    const outcome = await runtime.executeCopilotEntries({
      setId: session.setId,
      name: session.name,
      entries: [entry],
      options: session.options,
      lifecycle: createSessionLifecycle(session, lifecycle)
    });
    mergeOutcome(session, outcome);

    if (outcome.stopped || isStopping(session.runId)) {
      return finishStoppedSession(session, '作业集已被终止');
    }

    const settled = session.results.get(entry.key);
    if (!settled || settled.status === 'running' || settled.status === 'pending') {
      session.results.set(entry.key, {
        status: 'failed',
        error: readOptionalString(outcome.error, 'message') || '作业条目未确认完成'
      });
    }
    return settleManualQueue(session);
  } catch (error) {
    if ((isRecord(error) && Boolean(error.stopped)) || isStopping(session.runId)) {
      return finishStoppedSession(session, readOptionalString(error, 'message') || '作业集已被终止');
    }
    const errorCode = readOptionalString(error, 'code');
    if (errorCode === 'MAA_EXECUTION_BUSY') {
      session.phase = initial ? 'starting' : 'waiting';
      session.currentEntry = null;
      throw error;
    }
    if (errorCode === 'MAA_EXECUTION_SHUTTING_DOWN') {
      // 关闭期间拒绝新条目：不消耗条目，也不把集合写成成功或失败；集合 run 由
      // 关闭流程按停止意图结算，恢复继续请求时会得到可重试的 503。
      session.phase = initial ? 'starting' : 'waiting';
      session.currentEntry = null;
      throw error;
    }
    session.results.set(entry.key, {
      status: 'failed',
      error: readOptionalString(error, 'message') || '作业集执行失败'
    });
    return settleManualQueue(session);
  } finally {
    session.attempting = false;
  }
}

/**
 * Runs the whole selected queue as one continuous attempt. Entry failures are
 * reported as a failed Run with a per-entry summary, matching the synchronous
 * endpoint this replaces. A stop ends the queue before the next group.
 */
export async function runContinuousCopilotSet({
  runId,
  setId,
  raid,
  selectedIndexes = [],
  options = {},
  lifecycle = {}
}: CopilotSetRunInput): Promise<CopilotSetRunResult> {
  const session = await prepareSession({ runId, setId, raid, selectedIndexes, options, mode: 'continuous' });
  try {
    lifecycle.onPrepared?.(describePrepared(session));
    if (session.queue.length === 0) {
      const result = buildRunResult(session, { finished: true, message: '作业集没有待执行条目' });
      runtime.completeAgentRun(runId, result);
      return result;
    }

    const outcome = await runtime.executeCopilotEntries({
      setId: session.setId,
      name: session.name,
      entries: session.queue,
      options,
      lifecycle: createSessionLifecycle(session, lifecycle)
    });
    mergeOutcome(session, outcome);

    if (outcome.stopped || isStopping(runId)) {
      session.phase = 'stopped';
      session.currentEntry = null;
      normalizeRunningEntries(session, '作业集已被终止');
      return buildRunResult(session, { stopped: true, finished: true, message: '作业集已被终止' });
    }
    if (outcome.error) throw copilotSetExecutionError(session, outcome);

    const summary = buildSummary(session);
    session.phase = 'finished';
    session.currentEntry = null;
    return buildRunResult(session, {
      finished: true,
      message: summary.failedCount
        ? `作业集执行完成，${summary.failedCount} 项失败`
        : '作业集执行完成'
    });
  } finally {
    sessions.delete(runId);
  }
}

/**
 * Starts a manual set: runs the first pending entry, then moves the Run to
 * `waiting`. The waiting Run holds no lease, so another client may use the
 * device until the user asks for the next entry.
 */
export async function startManualCopilotSet({
  runId,
  setId,
  raid,
  selectedIndexes = [],
  options = {},
  lifecycle = {}
}: CopilotSetRunInput): Promise<CopilotSetManualOutcome> {
  const session = await prepareSession({ runId, setId, raid, selectedIndexes, options, mode: 'manual' });
  try {
    lifecycle.onPrepared?.(describePrepared(session));

    if (session.queue.length === 0) {
      const result = buildRunResult(session, { finished: true, message: '作业集没有待执行条目' });
      runtime.completeAgentRun(runId, result);
      return { waitingForNext: false, finished: true, result };
    }

    return await runManualAttempt(session, lifecycle, { initial: true });
  } catch (error) {
    sessions.delete(runId);
    throw error;
  }
}

/**
 * Executes the next pending entry of a manual set. A busy lease rejects with
 * `MAA_EXECUTION_BUSY` without consuming the entry or leaving the waiting
 * phase; the caller maps it to a retryable 409.
 */
export async function continueManualCopilotSet({
  runId,
  lifecycle = {}
}: ContinueCopilotSetInput): Promise<CopilotSetManualOutcome> {
  const session = sessions.get(runId);
  if (!session) throw sessionLostError(runId);

  const run = runtime.getAgentRun(runId);
  if (!run || run.state !== 'waiting') {
    if (run && TERMINAL_RUN_STATES.has(run.state)) sessions.delete(runId);
    throw copilotSetNotWaitingError(runId, run?.state || 'unknown');
  }

  try {
    return await runManualAttempt(session, lifecycle, { initial: false });
  } catch (error) {
    const current = runtime.getAgentRun(runId);
    if (!current || TERMINAL_RUN_STATES.has(current.state)) sessions.delete(runId);
    throw error;
  }
}

/**
 * Stops a copilot-set Run. A waiting Run becomes `stopped` immediately with
 * the per-entry summary and no device command; a running Run is reported so
 * the caller can confirm it is current and record the stop intent. The
 * executing loop observes the run state and will not start the next entry.
 */
export function requestCopilotSetRunStop(runId: string): CopilotSetStopOutcome | null {
  const run = runtime.getAgentRun(runId);
  if (!run) return null;

  const session = sessions.get(runId);
  if (run.state === 'waiting') {
    if (session) session.stopRequested = true;
    const result = session
      ? buildRunResult(session, {
        stopped: true,
        finished: true,
        message: '作业集已停止，未开始下一关'
      })
      : { success: true as const, stopped: true as const, message: '作业集已停止，未开始下一关' };
    sessions.delete(runId);
    return { disposition: 'stopped', run: runtime.stopAgentRun(runId, result) };
  }
  if (run.state === 'accepted') {
    sessions.delete(runId);
    return {
      disposition: 'canceled',
      run: runtime.stopAgentRun(runId, { canceled: true, reason: 'stop_requested_before_start' })
    };
  }
  if (run.state === 'running') {
    return { disposition: 'running', run };
  }
  return { disposition: 'terminal', run };
}

export function getCopilotSetRunProgress(runId: string): CopilotSetProgress | null {
  const session = sessions.get(runId);
  if (!session) return null;

  const attempted = attemptedTaskResults(session);
  const taskResults = buildTaskResults(session);
  const count = (status: CopilotSetEntryStatus) =>
    taskResults.filter(result => result.status === status).length;
  const pendingEntry = nextPendingEntry(session);
  const runningEntry = session.queue.find(entry => statusOf(session, entry) === 'running') || null;
  const currentStepEntry = runningEntry || pendingEntry;
  const currentStep = currentStepEntry
    ? session.queue.findIndex(entry => entry.key === currentStepEntry.key) + 1
    : attempted.length;
  const phase: CopilotSetProgressPhase = session.phase === 'starting' ? 'starting'
    : session.phase === 'waiting' ? 'waiting_for_next'
      : session.phase;
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    phase,
    currentStep,
    totalSteps: attempted.length,
    currentTask: session.currentEntry
      ? `第 ${session.currentEntry.itemIndex + 1} 项 ${session.currentEntry.displayStage}`
      : null,
    currentEntry: session.currentEntry || null,
    nextEntry: phase === 'waiting_for_next' ? pendingEntry : null,
    shouldStop: session.stopRequested,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    skippedCount: count('skipped'),
    pendingCount: count('pending'),
    message: phase === 'waiting_for_next'
      ? '等待开始下一关'
      : session.phase === 'running'
        ? '作业集执行中'
        : '等待作业集启动',
    taskResults
  };
}
