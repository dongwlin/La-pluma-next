import { agentError } from '../utils/apiHelper.ts';
import {
  completeAgentRun,
  getAgentRun,
  markAgentRunWaiting,
  setAgentRunAcceptedResult,
  startAgentRunForExecution,
  stopAgentRun
} from './agentRunService.js';
import { buildCopilotPlan, executeCopilotEntries } from './copilotPlanService.js';

const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);

/**
 * Server-held copilot-set sessions. A continuous set owns one Run for the
 * whole queue. A manual set owns one Run while it waits for the user between
 * entries; the waiting run holds no execution lease.
 */
const sessions = new Map();

const defaultRuntime = {
  buildCopilotPlan,
  executeCopilotEntries,
  getAgentRun,
  markAgentRunWaiting,
  completeAgentRun,
  setAgentRunAcceptedResult,
  startAgentRunForExecution,
  stopAgentRun
};
let runtime = defaultRuntime;

export function configureCopilotSetRuntimeForTests(overrides = {}) {
  runtime = { ...defaultRuntime, ...overrides };
}

export function resetCopilotSetRunStateForTests() {
  sessions.clear();
  runtime = defaultRuntime;
}

export function hasCopilotSetSession(runId) {
  return sessions.has(runId);
}

function copilotSetUnavailableError(setId, error) {
  return agentError('AGENT_COPILOT_SET_UNAVAILABLE', `作业集计划获取失败: ${error?.message || error}`, {
    statusCode: 502,
    details: { setId },
    retryable: true
  });
}

function copilotSetNotWaitingError(runId, state) {
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

function sessionLostError(runId) {
  return agentError('AGENT_COPILOT_SET_SESSION_LOST', '作业集会话已失效，无法继续下一关', {
    statusCode: 409,
    details: { runId },
    retryable: false
  });
}

function createSession({ runId, plan, mode, raid, options, selectedIndexes }) {
  const selected = new Set((selectedIndexes || []).map(Number));
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
    stopRequested: false,
    attempting: false,
    phase: 'starting',
    currentEntry: null,
    startedAt: Date.now()
  };
}

function describePrepared(session) {
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    totalEntries: session.queue.length,
    alreadyCompletedCount: session.alreadyCompletedCount,
    selectedCount: session.scope.length
  };
}

function statusOf(session, entry) {
  return session.results.get(entry.key)?.status || 'pending';
}

function isStopping(runId) {
  const run = runtime.getAgentRun(runId);
  return !run || run.state === 'stopping' || TERMINAL_RUN_STATES.has(run.state);
}

function mergeOutcome(session, outcome) {
  for (const key of outcome?.completed || []) session.completed.add(key);
  for (const result of outcome?.summary?.taskResults || []) {
    session.results.set(result.key, { status: result.status, error: result.error });
  }
}

function buildTaskResults(session) {
  return session.queue.map(entry => {
    const settled = session.results.get(entry.key) || { status: 'pending' };
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

function buildSummary(session) {
  const taskResults = buildTaskResults(session);
  const count = status => taskResults.filter(result => result.status === status).length;
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    raid: session.raid,
    totalEntries: taskResults.length,
    attemptedCount: taskResults.length - count('pending'),
    alreadyCompletedCount: session.alreadyCompletedCount,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    durationMs: Date.now() - session.startedAt,
    errors: taskResults
      .filter(result => result.status === 'failed')
      .map(result => ({ key: result.key, stage: result.displayStage, error: result.error })),
    taskResults
  };
}

function buildLegacyExtras(session) {
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

function nextPendingEntry(session) {
  return session.queue.find(entry => statusOf(session, entry) === 'pending') || null;
}

function buildRunResult(session, { stopped = false, finished = false, waitingForNext = false, message } = {}) {
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

function createSessionLifecycle(session, lifecycle) {
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
      session.currentEntry = entry;
      for (const item of entries) session.results.set(item.key, { status: 'running' });
    },
    onEntrySettled: (entry, status, error) => {
      session.results.set(entry.key, { status, error });
      if (status === 'success') session.completed.add(entry.key);
    }
  };
}

async function prepareSession({ runId, setId, raid, selectedIndexes, options, mode }) {
  let plan;
  try {
    plan = await runtime.buildCopilotPlan(setId, raid);
  } catch (error) {
    throw copilotSetUnavailableError(setId, error);
  }
  const session = createSession({ runId, plan, mode, raid, options, selectedIndexes });
  sessions.set(runId, session);
  return session;
}

function copilotSetExecutionError(session, outcome) {
  const summary = outcome.summary || buildSummary(session);
  const failedCount = summary.failedCount || 0;
  const message = outcome.error?.message
    || (failedCount ? `作业集执行失败，${failedCount} 项未完成` : '作业集执行失败');
  const error = new Error(message, { cause: outcome.error });
  error.code = outcome.error?.code || 'COPILOT_PLAN_FAILED';
  error.statusCode = outcome.error?.statusCode || 422;
  error.details = {
    ...(outcome.error?.details || {}),
    setId: session.setId,
    mode: session.mode,
    plan: session.plan,
    results: outcome.results || [],
    completed: [...session.completed],
    summary,
    stopped: false
  };
  error.retryable = true;
  return error;
}

function normalizeRunningEntries(session, message) {
  for (const [key, settled] of session.results) {
    if (settled.status !== 'running') continue;
    session.results.set(key, { status: 'stopped', error: message });
  }
}

function finishStoppedSession(session, message) {
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

function settleManualQueue(session) {
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

async function runManualAttempt(session, lifecycle, { initial } = {}) {
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
        error: outcome.error?.message || '作业条目未确认完成'
      });
    }
    return settleManualQueue(session);
  } catch (error) {
    if (error?.stopped || isStopping(session.runId)) {
      return finishStoppedSession(session, error?.message || '作业集已被终止');
    }
    if (error?.code === 'MAA_EXECUTION_BUSY') {
      session.phase = initial ? 'starting' : 'waiting';
      session.currentEntry = null;
      throw error;
    }
    session.results.set(entry.key, { status: 'failed', error: error?.message || '作业集执行失败' });
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
}) {
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
}) {
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
export async function continueManualCopilotSet({ runId, lifecycle = {} }) {
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
export function requestCopilotSetRunStop(runId) {
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
      : { success: true, stopped: true, message: '作业集已停止，未开始下一关' };
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

export function getCopilotSetRunProgress(runId) {
  const session = sessions.get(runId);
  if (!session) return null;

  const taskResults = buildTaskResults(session);
  const count = status => taskResults.filter(result => result.status === status).length;
  const pendingEntry = nextPendingEntry(session);
  const phase = session.phase === 'starting' ? 'starting'
    : session.phase === 'waiting' ? 'waiting_for_next'
      : session.phase;
  return {
    setId: session.setId,
    name: session.name,
    mode: session.mode,
    phase,
    currentStep: taskResults.length - count('pending'),
    totalSteps: taskResults.length,
    currentTask: session.currentEntry
      ? `第 ${session.currentEntry.itemIndex + 1} 项 ${session.currentEntry.displayStage}`
      : null,
    currentEntry: session.currentEntry || null,
    nextEntry: phase === 'waiting_for_next' ? pendingEntry : null,
    shouldStop: session.stopRequested,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    message: phase === 'waiting_for_next'
      ? '等待开始下一关'
      : session.phase === 'running'
        ? '作业集执行中'
        : '等待作业集启动',
    taskResults
  };
}
