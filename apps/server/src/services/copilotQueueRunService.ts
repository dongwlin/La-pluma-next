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
import { buildCopilotQueuePlan, executeCopilotQueueEntries } from './copilotPlanService.ts';
import type {
  CopilotEntryOutcomeStatus,
  CopilotExecutionEntry,
  CopilotExecutionLifecycle,
  CopilotExecutionOptions,
  CopilotQueueEntriesOutcome,
  CopilotQueueEntryInput,
  CopilotQueueFailurePolicy,
  CopilotQueuePlan,
  CopilotQueuePlanEntry,
  CopilotRaidMode,
  ExecuteCopilotQueueEntriesInput
} from './copilotPlanService.ts';
import { CopilotManagedFileInvalidError, readManagedCopilotFile } from './copilotFileService.ts';

const TERMINAL_RUN_STATES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'succeeded',
  'failed',
  'stopped',
  'interrupted'
]);

export type CopilotQueueMode = 'continuous' | 'manual';

type CopilotQueueSessionPhase = 'starting' | 'running' | 'waiting' | 'finished' | 'stopped';

export type CopilotQueueProgressPhase = 'starting' | 'running' | 'waiting_for_next' | 'finished' | 'stopped';

export type CopilotQueueEntryStatus = 'pending' | 'running' | 'skipped' | CopilotEntryOutcomeStatus;

export interface CopilotQueueEntryState {
  status: CopilotQueueEntryStatus;
  error?: string;
}

export interface CopilotQueueTaskResult {
  clientId: string;
  itemIndex: number;
  stage: string;
  stageId: string;
  apCost: number | null;
  mode: CopilotRaidMode;
  status: CopilotQueueEntryStatus;
  error?: string;
}

export interface CopilotQueueNextEntry {
  clientId: string;
  itemIndex: number;
  stage: string;
  mode: CopilotRaidMode;
}

export interface CopilotQueueSummaryError {
  clientId: string;
  itemIndex: number;
  stage: string;
  mode: CopilotRaidMode;
  error: string;
}

export interface CopilotQueueSummary {
  queueId: string;
  name: string;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  totalEntries: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  stoppedCount: number;
  pendingCount: number;
  durationMs: number;
  errors: CopilotQueueSummaryError[];
  taskResults: CopilotQueueTaskResult[];
}

export interface CopilotQueueRunResult {
  success: true;
  stopped: boolean;
  finished: boolean;
  waitingForNext: boolean;
  nextEntry?: CopilotQueueNextEntry;
  mode: CopilotQueueMode;
  queueId: string;
  name: string;
  failurePolicy: CopilotQueueFailurePolicy;
  message: string;
  summary: CopilotQueueSummary;
}

export interface CopilotQueueProgress {
  queueId: string;
  name: string;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  phase: CopilotQueueProgressPhase;
  currentStep: number | null;
  totalSteps: number;
  currentClientId: string | null;
  currentTask: string | null;
  nextEntry: CopilotQueueNextEntry | null;
  shouldStop: boolean;
  message: string;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  stoppedCount: number;
  pendingCount: number;
  taskResults: CopilotQueueTaskResult[];
}

export interface CopilotQueueWaitingOutcome {
  waitingForNext: true;
  finished: false;
  nextEntry: CopilotQueueNextEntry;
  result: CopilotQueueRunResult;
}

export interface CopilotQueueFinishedOutcome {
  waitingForNext: false;
  finished: true;
  result: CopilotQueueRunResult;
}

export interface CopilotQueueStoppedOutcome {
  stopped: true;
  finished: true;
  result: CopilotQueueRunResult;
}

export type CopilotQueueManualOutcome =
  | CopilotQueueWaitingOutcome
  | CopilotQueueFinishedOutcome
  | CopilotQueueStoppedOutcome;

export type CopilotQueueStopDisposition = 'stopped' | 'canceled' | 'running' | 'terminal';

export interface CopilotQueueStopOutcome {
  disposition: CopilotQueueStopDisposition;
  run: AgentRunDto;
}

export interface CopilotQueueSkipOutcome {
  skippedClientId: string | null;
  waitingForNext: boolean;
  finished: boolean;
  nextEntry?: CopilotQueueNextEntry;
  result: CopilotQueueRunResult;
  run: AgentRunDto;
}

export interface CopilotQueuePreparedInfo {
  queueId: string;
  name: string;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  totalEntries: number;
}

export interface CopilotQueueLifecycle extends CopilotExecutionLifecycle {
  onPrepared?: (info: CopilotQueuePreparedInfo) => void;
}

export interface CopilotQueueRunInput {
  runId: string;
  queueId: string;
  name: string;
  entries: readonly CopilotQueueEntryInput[];
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  options?: CopilotExecutionOptions;
  lifecycle?: CopilotQueueLifecycle;
}

export interface ContinueCopilotQueueInput {
  runId: string;
  lifecycle?: CopilotQueueLifecycle;
}

export interface CopilotQueueSession {
  runId: string;
  queueId: string;
  name: string;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  entries: CopilotQueuePlanEntry[];
  options: CopilotExecutionOptions;
  results: Map<string, CopilotQueueEntryState>;
  stopRequested: boolean;
  attempting: boolean;
  phase: CopilotQueueSessionPhase;
  currentEntry: CopilotExecutionEntry | null;
  startedAt: number;
}

export interface CopilotQueueRuntime {
  buildCopilotQueuePlan(entries: readonly CopilotQueueEntryInput[]): Promise<CopilotQueuePlan>;
  executeCopilotQueueEntries(input: ExecuteCopilotQueueEntriesInput): Promise<CopilotQueueEntriesOutcome>;
  getAgentRun(runId: string): AgentRunDto | null;
  markAgentRunWaiting(runId: string): AgentRunDto;
  completeAgentRun(runId: string, result?: unknown): AgentRunDto;
  setAgentRunAcceptedResult(runId: string, result?: unknown): AgentRunDto;
  startAgentRunForExecution(runId: string): AgentRunDto;
  stopAgentRun(runId: string, result?: unknown): AgentRunDto;
}

const sessions = new Map<string, CopilotQueueSession>();

const defaultRuntime: CopilotQueueRuntime = {
  buildCopilotQueuePlan,
  executeCopilotQueueEntries,
  getAgentRun,
  markAgentRunWaiting,
  completeAgentRun,
  setAgentRunAcceptedResult,
  startAgentRunForExecution,
  stopAgentRun
};
let runtime: CopilotQueueRuntime = defaultRuntime;

export function configureCopilotQueueRuntimeForTests(
  overrides: Partial<CopilotQueueRuntime> = {}
): void {
  runtime = { ...defaultRuntime, ...overrides };
}

export function resetCopilotQueueRunStateForTests(): void {
  sessions.clear();
  runtime = defaultRuntime;
}

export function hasCopilotQueueSession(runId: string): boolean {
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

function copilotQueueUnavailableError(queueId: string, error: unknown): AgentError {
  return agentError('AGENT_COPILOT_QUEUE_UNAVAILABLE', `作业队列计划获取失败: ${describeError(error)}`, {
    statusCode: 502,
    details: { queueId },
    retryable: true
  });
}

function copilotQueueNotWaitingError(runId: string, state: string): AgentError {
  return agentError(
    'AGENT_COPILOT_QUEUE_NOT_WAITING',
    `作业队列当前不处于等待下一项状态（${state}）`,
    {
      statusCode: 409,
      details: { runId, state },
      retryable: state === 'accepted' || state === 'running' || state === 'stopping'
    }
  );
}

function sessionLostError(runId: string): AgentError {
  return agentError('AGENT_COPILOT_QUEUE_SESSION_LOST', '作业队列会话已失效，无法继续下一项', {
    statusCode: 409,
    details: { runId },
    retryable: false
  });
}

export interface CopilotQueueFileEntry {
  clientId: string;
  source: string;
  filename?: string;
}

export async function assertCopilotQueueFilesReadable(
  entries: readonly CopilotQueueFileEntry[]
): Promise<void> {
  for (const entry of entries) {
    if (entry.source !== 'file' || !entry.filename) continue;
    try {
      await readManagedCopilotFile(entry.filename);
    } catch (error) {
      if (error instanceof CopilotManagedFileInvalidError) {
        throw agentError('AGENT_VALIDATION_COPILOT_QUEUE_FILE_INVALID', error.message, {
          statusCode: 400,
          details: { clientId: entry.clientId, filename: entry.filename, reason: error.reason },
          retryable: false
        });
      }
      throw error;
    }
  }
}

function createSession({
  runId,
  queueId,
  name,
  plan,
  mode,
  failurePolicy,
  options
}: {
  runId: string;
  queueId: string;
  name: string;
  plan: CopilotQueuePlan;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  options: CopilotExecutionOptions;
}): CopilotQueueSession {
  return {
    runId,
    queueId,
    name,
    mode,
    failurePolicy,
    entries: plan.entries,
    options,
    results: new Map(plan.entries.map(entry => [entry.key, { status: 'pending' }])),
    stopRequested: false,
    attempting: false,
    phase: 'starting',
    currentEntry: null,
    startedAt: Date.now()
  };
}

async function prepareSession({
  runId,
  queueId,
  name,
  entries,
  mode,
  failurePolicy,
  options
}: {
  runId: string;
  queueId: string;
  name: string;
  entries: readonly CopilotQueueEntryInput[];
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  options: CopilotExecutionOptions;
}): Promise<CopilotQueueSession> {
  let plan: CopilotQueuePlan;
  try {
    plan = await runtime.buildCopilotQueuePlan(entries);
  } catch (error) {
    throw copilotQueueUnavailableError(queueId, error);
  }
  const session = createSession({ runId, queueId, name, plan, mode, failurePolicy, options });
  sessions.set(runId, session);
  return session;
}

function describePrepared(session: CopilotQueueSession): CopilotQueuePreparedInfo {
  return {
    queueId: session.queueId,
    name: session.name,
    mode: session.mode,
    failurePolicy: session.failurePolicy,
    totalEntries: session.entries.length
  };
}

function statusOf(session: CopilotQueueSession, entry: CopilotQueuePlanEntry): CopilotQueueEntryStatus {
  return session.results.get(entry.key)?.status || 'pending';
}

function isStopping(runId: string): boolean {
  const run = runtime.getAgentRun(runId);
  return !run || run.state === 'stopping' || TERMINAL_RUN_STATES.has(run.state);
}

function mergeOutcome(session: CopilotQueueSession, outcome: CopilotQueueEntriesOutcome): void {
  for (const settled of outcome.statuses) {
    session.results.set(settled.entry.key, { status: settled.status, error: settled.error });
  }
}

function buildTaskResults(session: CopilotQueueSession): CopilotQueueTaskResult[] {
  return session.entries.map(entry => {
    const settled: CopilotQueueEntryState = session.results.get(entry.key) || { status: 'pending' };
    return {
      clientId: entry.clientId,
      itemIndex: entry.itemIndex,
      stage: entry.displayStage,
      stageId: entry.stageId,
      apCost: entry.apCost,
      mode: entry.mode,
      status: settled.status,
      ...(settled.error ? { error: settled.error } : {})
    };
  });
}

function buildSummary(session: CopilotQueueSession): CopilotQueueSummary {
  const taskResults = buildTaskResults(session);
  const count = (status: CopilotQueueEntryStatus) =>
    taskResults.filter(result => result.status === status).length;
  return {
    queueId: session.queueId,
    name: session.name,
    mode: session.mode,
    failurePolicy: session.failurePolicy,
    totalEntries: taskResults.length,
    successCount: count('success'),
    failedCount: count('failed'),
    skippedCount: count('skipped'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    durationMs: Date.now() - session.startedAt,
    errors: taskResults
      .filter(result => result.status === 'failed')
      .map(({ clientId, itemIndex, stage, mode, error }) => ({ clientId, itemIndex, stage, mode, error: error || '' })),
    taskResults
  };
}

function nextPendingEntry(session: CopilotQueueSession): CopilotQueuePlanEntry | null {
  return session.entries.find(entry => statusOf(session, entry) === 'pending') || null;
}

function nextEntryOf(entry: CopilotQueuePlanEntry): CopilotQueueNextEntry {
  return {
    clientId: entry.clientId,
    itemIndex: entry.itemIndex,
    stage: entry.displayStage,
    mode: entry.mode
  };
}

function buildRunResult(
  session: CopilotQueueSession,
  {
    stopped = false,
    finished = false,
    waitingForNext = false,
    message
  }: {
    stopped?: boolean;
    finished?: boolean;
    waitingForNext?: boolean;
    message?: string;
  } = {}
): CopilotQueueRunResult {
  const pendingEntry = waitingForNext ? nextPendingEntry(session) : null;
  return {
    success: true,
    stopped,
    finished,
    waitingForNext,
    ...(pendingEntry ? { nextEntry: nextEntryOf(pendingEntry) } : {}),
    mode: session.mode,
    queueId: session.queueId,
    name: session.name,
    failurePolicy: session.failurePolicy,
    message: message || (waitingForNext ? '等待开始下一项' : '作业队列执行完成'),
    summary: buildSummary(session)
  };
}

/**
 * 共享生命周期签名接受更宽的条目类型（活动执行复用）；队列会话只会通过
 * 自己的计划条目收到回调。
 */
function queueEntryOf(entry: CopilotExecutionEntry): CopilotQueuePlanEntry {
  return entry as CopilotQueuePlanEntry;
}

function createSessionLifecycle(
  session: CopilotQueueSession,
  lifecycle: CopilotQueueLifecycle
): CopilotExecutionLifecycle {
  return {
    ...lifecycle,
    onBeforeStart: async () => {
      await lifecycle.onBeforeStart?.();
      runtime.startAgentRunForExecution(session.runId);
    },
    shouldStop: async () => session.stopRequested
      || Boolean(await lifecycle.shouldStop?.())
      || isStopping(session.runId),
    onEntryStarted: entry => {
      session.phase = 'running';
      session.currentEntry = entry;
      session.results.set(queueEntryOf(entry).key, { status: 'running' });
    },
    onEntrySettled: (entry, status, error) => {
      session.results.set(queueEntryOf(entry).key, { status, error });
    }
  };
}

function normalizeRunningEntries(session: CopilotQueueSession, message: string): void {
  for (const [key, settled] of session.results) {
    if (settled.status !== 'running') continue;
    session.results.set(key, { status: 'stopped', error: message });
  }
}

function copilotQueueExecutionError(
  session: CopilotQueueSession,
  outcome: CopilotQueueEntriesOutcome
): Error {
  const summary = buildSummary(session);
  const message = readOptionalString(outcome.error, 'message')
    || (summary.failedCount ? `作业队列执行失败，${summary.failedCount} 项未完成` : '作业队列执行失败');
  const error = new Error(message, { cause: outcome.error });
  Object.assign(error, {
    code: readOptionalString(outcome.error, 'code') || 'COPILOT_QUEUE_FAILED',
    statusCode: readOptionalNumber(outcome.error, 'statusCode') || 422,
    details: {
      ...readRecordField(outcome.error, 'details'),
      queueId: session.queueId,
      mode: session.mode,
      failurePolicy: session.failurePolicy,
      completed: outcome.completed,
      summary,
      stopped: false
    },
    retryable: !isRecord(outcome.error) || outcome.error.retryable !== false
  });
  return error;
}

function finishStoppedSession(
  session: CopilotQueueSession,
  message?: string
): CopilotQueueStoppedOutcome {
  const stopMessage = message || '作业队列已被终止';
  session.stopRequested = true;
  session.phase = 'stopped';
  session.currentEntry = null;
  normalizeRunningEntries(session, stopMessage);
  const result = buildRunResult(session, { stopped: true, finished: true, message: stopMessage });
  sessions.delete(session.runId);
  const run = runtime.getAgentRun(session.runId);
  if (run && !TERMINAL_RUN_STATES.has(run.state) && run.state !== 'stopped') {
    runtime.stopAgentRun(session.runId, result);
  }
  return { stopped: true, finished: true, result };
}

function finishManualQueue(session: CopilotQueueSession): CopilotQueueFinishedOutcome {
  const summary = buildSummary(session);
  const result = buildRunResult(session, {
    finished: true,
    message: summary.failedCount
      ? `作业队列执行完成，${summary.failedCount} 项失败`
      : '作业队列执行完成'
  });
  runtime.completeAgentRun(session.runId, result);
  session.phase = 'finished';
  session.currentEntry = null;
  sessions.delete(session.runId);
  return { waitingForNext: false, finished: true, result };
}

function settleManualQueue(session: CopilotQueueSession): CopilotQueueManualOutcome {
  if (session.stopRequested || isStopping(session.runId)) {
    return finishStoppedSession(session, '作业队列已被终止');
  }

  const pendingEntry = nextPendingEntry(session);
  if (!pendingEntry) return finishManualQueue(session);

  const run = runtime.getAgentRun(session.runId);
  if (!run || run.state !== 'running') return finishStoppedSession(session, '作业队列已被终止');

  runtime.markAgentRunWaiting(session.runId);
  session.phase = 'waiting';
  session.currentEntry = null;
  const result = buildRunResult(session, {
    waitingForNext: true,
    message: '本项已完成，等待开始下一项'
  });
  runtime.setAgentRunAcceptedResult(session.runId, result);
  return { waitingForNext: true, finished: false, nextEntry: nextEntryOf(pendingEntry), result };
}

function settledAfterManualAttempt(session: CopilotQueueSession): CopilotQueueManualOutcome {
  const failed = session.entries.some(entry => statusOf(session, entry) === 'failed');
  if (failed && session.failurePolicy === 'stop') return finishManualQueue(session);
  return settleManualQueue(session);
}

async function runManualAttempt(
  session: CopilotQueueSession,
  lifecycle: CopilotQueueLifecycle,
  { initial }: { initial: boolean }
): Promise<CopilotQueueManualOutcome> {
  const expectedState = initial ? 'accepted' : 'waiting';
  const run = runtime.getAgentRun(session.runId);
  if (!run || run.state !== expectedState) {
    throw copilotQueueNotWaitingError(session.runId, run?.state || 'unknown');
  }

  const entry = nextPendingEntry(session);
  if (!entry) return settleManualQueue(session);
  if (session.attempting) {
    throw copilotQueueNotWaitingError(session.runId, 'running');
  }

  session.attempting = true;
  session.phase = 'starting';
  session.currentEntry = entry;
  try {
    const outcome = await runtime.executeCopilotQueueEntries({
      queueId: session.queueId,
      name: session.name,
      entries: [entry],
      options: session.options,
      failurePolicy: session.failurePolicy,
      lifecycle: createSessionLifecycle(session, lifecycle)
    });
    mergeOutcome(session, outcome);

    if (outcome.stopped || isStopping(session.runId)) {
      return finishStoppedSession(session, '作业队列已被终止');
    }

    const settled = session.results.get(entry.key);
    if (!settled || settled.status === 'running' || settled.status === 'pending') {
      session.results.set(entry.key, {
        status: 'failed',
        error: readOptionalString(outcome.error, 'message') || '作业条目未确认完成'
      });
    }
    return settledAfterManualAttempt(session);
  } catch (error) {
    if ((isRecord(error) && Boolean(error.stopped)) || isStopping(session.runId)) {
      return finishStoppedSession(session, readOptionalString(error, 'message') || '作业队列已被终止');
    }
    const errorCode = readOptionalString(error, 'code');
    if (errorCode === 'MAA_EXECUTION_BUSY' || errorCode === 'MAA_EXECUTION_SHUTTING_DOWN') {
      session.phase = initial ? 'starting' : 'waiting';
      session.currentEntry = null;
      throw error;
    }
    session.results.set(entry.key, {
      status: 'failed',
      error: readOptionalString(error, 'message') || '作业条目执行失败'
    });
    return settledAfterManualAttempt(session);
  } finally {
    session.attempting = false;
  }
}

export async function runContinuousCopilotQueue({
  runId,
  queueId,
  name,
  entries,
  mode,
  failurePolicy,
  options = {},
  lifecycle = {}
}: CopilotQueueRunInput): Promise<CopilotQueueRunResult> {
  const session = await prepareSession({ runId, queueId, name, entries, mode, failurePolicy, options });
  try {
    lifecycle.onPrepared?.(describePrepared(session));
    const outcome = await runtime.executeCopilotQueueEntries({
      queueId: session.queueId,
      name: session.name,
      entries: session.entries,
      options: session.options,
      failurePolicy: session.failurePolicy,
      lifecycle: createSessionLifecycle(session, lifecycle)
    });
    mergeOutcome(session, outcome);

    if (outcome.stopped || isStopping(runId)) {
      session.phase = 'stopped';
      session.currentEntry = null;
      normalizeRunningEntries(session, '作业队列已被终止');
      return buildRunResult(session, { stopped: true, finished: true, message: '作业队列已被终止' });
    }
    if (outcome.error) throw copilotQueueExecutionError(session, outcome);

    const summary = buildSummary(session);
    session.phase = 'finished';
    session.currentEntry = null;
    return buildRunResult(session, {
      finished: true,
      message: summary.failedCount
        ? `作业队列执行完成，${summary.failedCount} 项失败`
        : '作业队列执行完成'
    });
  } finally {
    sessions.delete(runId);
  }
}

export async function startManualCopilotQueue(input: CopilotQueueRunInput): Promise<CopilotQueueManualOutcome> {
  const lifecycle = input.lifecycle || {};
  const session = await prepareSession({
    runId: input.runId,
    queueId: input.queueId,
    name: input.name,
    entries: input.entries,
    mode: input.mode,
    failurePolicy: input.failurePolicy,
    options: input.options || {}
  });
  try {
    lifecycle.onPrepared?.(describePrepared(session));
    return await runManualAttempt(session, lifecycle, { initial: true });
  } catch (error) {
    sessions.delete(input.runId);
    throw error;
  }
}

export async function continueManualCopilotQueue({
  runId,
  lifecycle = {}
}: ContinueCopilotQueueInput): Promise<CopilotQueueManualOutcome> {
  const session = sessions.get(runId);
  if (!session) throw sessionLostError(runId);

  const run = runtime.getAgentRun(runId);
  if (!run || run.state !== 'waiting') {
    if (run && TERMINAL_RUN_STATES.has(run.state)) sessions.delete(runId);
    throw copilotQueueNotWaitingError(runId, run?.state || 'unknown');
  }

  try {
    return await runManualAttempt(session, lifecycle, { initial: false });
  } catch (error) {
    const current = runtime.getAgentRun(runId);
    if (!current || TERMINAL_RUN_STATES.has(current.state)) sessions.delete(runId);
    throw error;
  }
}

export function requestCopilotQueueSkip(runId: string): CopilotQueueSkipOutcome {
  const run = runtime.getAgentRun(runId);
  if (!run) {
    throw agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${runId}`, {
      statusCode: 404,
      details: { runId },
      retryable: false
    });
  }
  const session = sessions.get(runId);
  if (!session) {
    if (run.state === 'waiting') throw sessionLostError(runId);
    throw copilotQueueNotWaitingError(runId, run.state);
  }
  if (run.state !== 'waiting' || session.mode !== 'manual' || session.attempting) {
    throw copilotQueueNotWaitingError(runId, session.attempting ? 'running' : run.state);
  }

  const completedRun = (): AgentRunDto => {
    const current = runtime.getAgentRun(runId);
    if (!current) throw new Error('Agent run 不存在');
    return current;
  };

  const entry = nextPendingEntry(session);
  if (!entry) {
    const finished = finishManualQueue(session);
    return {
      skippedClientId: null,
      waitingForNext: false,
      finished: true,
      result: finished.result,
      run: completedRun()
    };
  }

  session.results.set(entry.key, { status: 'skipped' });
  const pendingEntry = nextPendingEntry(session);
  if (!pendingEntry) {
    const finished = finishManualQueue(session);
    return {
      skippedClientId: entry.clientId,
      waitingForNext: false,
      finished: true,
      result: finished.result,
      run: completedRun()
    };
  }

  session.phase = 'waiting';
  const result = buildRunResult(session, {
    waitingForNext: true,
    message: '已跳过当前项，等待开始下一项'
  });
  return {
    skippedClientId: entry.clientId,
    waitingForNext: true,
    finished: false,
    nextEntry: nextEntryOf(pendingEntry),
    result,
    run: runtime.setAgentRunAcceptedResult(runId, result)
  };
}

export function requestCopilotQueueRunStop(runId: string): CopilotQueueStopOutcome | null {
  const run = runtime.getAgentRun(runId);
  if (!run) return null;

  const session = sessions.get(runId);
  if (run.state === 'waiting') {
    if (session) session.stopRequested = true;
    const result = session
      ? buildRunResult(session, {
        stopped: true,
        finished: true,
        message: '作业队列已停止，未开始下一项'
      })
      : { success: true as const, stopped: true as const, message: '作业队列已停止，未开始下一项' };
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

export function getCopilotQueueRunProgress(runId: string): CopilotQueueProgress | null {
  const session = sessions.get(runId);
  if (!session) return null;

  const taskResults = buildTaskResults(session);
  const count = (status: CopilotQueueEntryStatus) =>
    taskResults.filter(result => result.status === status).length;
  const runningEntry = session.entries.find(entry => statusOf(session, entry) === 'running') || null;
  const pendingEntry = nextPendingEntry(session);
  const currentEntry = runningEntry || pendingEntry;
  const currentStep = currentEntry ? session.entries.indexOf(currentEntry) + 1 : null;
  const phase: CopilotQueueProgressPhase = session.phase === 'waiting' ? 'waiting_for_next' : session.phase;
  return {
    queueId: session.queueId,
    name: session.name,
    mode: session.mode,
    failurePolicy: session.failurePolicy,
    phase,
    currentStep,
    totalSteps: session.entries.length,
    currentClientId: currentEntry?.clientId || null,
    currentTask: currentEntry ? `第 ${currentStep} 项 ${currentEntry.displayStage}` : null,
    nextEntry: phase === 'waiting_for_next' && pendingEntry ? nextEntryOf(pendingEntry) : null,
    shouldStop: session.stopRequested || isStopping(session.runId),
    message: phase === 'waiting_for_next'
      ? '等待开始下一项'
      : session.phase === 'running'
        ? '作业队列执行中'
        : '等待作业队列启动',
    successCount: count('success'),
    failedCount: count('failed'),
    skippedCount: count('skipped'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    taskResults
  };
}
