import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import {
  executeScheduledTaskFromCron,
  executeScheduleNow,
  getScheduleExecutionStatus,
  stopScheduleExecution
} from '../schedulerService.ts';
import type { ScheduledDailyFlowRunResult } from '../schedulerService.ts';
import {
  beginAgentRun,
  completeAgentRun,
  flushAgentRunStore,
  getAgentRun,
  listAgentRuns,
  resetAgentRunsForTests,
  startAgentRun
} from '../agentRunService.ts';
import type { AgentRunDto } from '../agentRunService.ts';
import { buildAgentRunSnapshot } from '../runSnapshotService.ts';
import { getTaskStatus } from '../maaProcessService.ts';
import { getTodayOpenStages } from '../notificationService.ts';
import type {
  ScheduleExecutionStatus,
  ScheduleFlowCompletedResult,
  ScheduleFlowExecutionResult,
  ScheduleFlowExecutor,
  ScheduleFlowRejectedResult
} from '../scheduleFlowExecution.ts';
import type { FlowExecutionSummary } from '../scheduleFlowResult.ts';

let testDir = '';
let lockFile = '';

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'la-pluma-scheduler-'));
  lockFile = join(testDir, 'maa.lock');
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockFile;
});

beforeEach(async () => {
  resetAgentRunsForTests();
  await rm(lockFile, { force: true });
});

after(async () => {
  delete process.env.LA_PLUMA_MAA_LOCK_FILE;
  await rm(testDir, { recursive: true, force: true });
});

const fastTaskFlow = [
  { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} },
  { id: 'infrast-1', commandId: 'infrast', name: '基建换班', enabled: true, params: { facility: [] } }
];

const malformedTaskFlow = [{ enabled: true, name: 'Malformed task', params: {} }];

function completedResult(result: ScheduleFlowExecutionResult): ScheduleFlowCompletedResult {
  if (!result.success) throw new Error(result.message);
  return result;
}

function rejectedResult(result: ScheduleFlowExecutionResult): ScheduleFlowRejectedResult {
  if (result.success) throw new Error('expected a rejected flow');
  return result;
}

function dailyFlowResult(run: AgentRunDto | null): ScheduledDailyFlowRunResult {
  assert.ok(run);
  assert.ok(run.result && typeof run.result === 'object');
  return run.result as ScheduledDailyFlowRunResult;
}

test('unexpected execution errors always reset scheduler state', async () => {
  let started = 0;
  await assert.rejects(
    executeScheduleNow('unexpected-error', malformedTaskFlow, {
      onStarted: () => { started += 1; }
    }),
    error => error instanceof TypeError
  );

  assert.equal(started, 1);
  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.equal(status.scheduleId, null);
  assert.equal(status.currentStep, -1);
  assert.equal(status.totalSteps, 0);
  assert.equal(status.currentTask, null);
  assert.equal(status.shouldStop, false);
  assert.match(status.message, /任务流程异常终止/);
  assert.equal(status.taskResults.some(task => task.status === 'running'), false);
});

test('cron execution catches rejected task flows and leaves the scheduler reusable', async () => {
  const result = await executeScheduledTaskFromCron(malformedTaskFlow, 'cron-error');

  const reject = rejectedResult(result);
  assert.match(reject.message, /split/);
  assert.equal(getScheduleExecutionStatus().isRunning, false);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'failed');
  assert.ok(runs[0].error);
  assert.match(runs[0].error.message, /split/);
});

test('manual completion effects wait for the run terminal state and released lease', async () => {
  const order: string[] = [];
  let leaseActive = false;
  const emptySummary: FlowExecutionSummary = {
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    durationMs: 0,
    summaries: [],
    reports: [],
    actions: [],
    errors: [],
    warnings: [],
    taskResults: []
  };
  const fakeExecutor: ScheduleFlowExecutor = {
    async execute() {
      leaseActive = true;
      order.push('execute');
      leaseActive = false;
      return { success: true, stopped: false, message: '完成', summary: emptySummary };
    },
    getStatus: () => ({
      isRunning: false,
      scheduleId: null,
      runId: null,
      currentStep: -1,
      totalSteps: 0,
      currentTask: null,
      currentTaskId: null,
      message: '',
      startTime: null,
      shouldStop: false,
      lastResult: null,
      taskResults: []
    }),
    stop: () => false,
    async dispatchCompletion() {
      const run = listAgentRuns({ operationId: 'run_daily_flow' })[0];
      order.push(`dispatch:${run?.state || 'missing'}:${leaseActive}`);
      return { performed: true, errors: [] };
    }
  };

  const reservation = beginAgentRun({ operationId: 'run_daily_flow', input: { scheduleId: 'manual-order' } });
  startAgentRun(reservation.run.runId);
  await executeScheduleNow('manual-order', fastTaskFlow, {}, { runId: reservation.run.runId }, { executor: fakeExecutor });
  // 模拟 HTTP/后台调用方在 execute 返回后的微任务里结算 Run。
  completeAgentRun(reservation.run.runId, { success: true });
  await flushAgentRunStore();

  await waitForCondition(() => order.length === 2);
  assert.deepEqual(order, ['execute', 'dispatch:succeeded:false']);
});

test('cron dispatches completion side effects only after the run is settled', async () => {
  const order: string[] = [];
  const emptySummary: FlowExecutionSummary = {
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    durationMs: 0,
    summaries: [],
    reports: [],
    actions: [],
    errors: [],
    warnings: [],
    taskResults: []
  };
  const fakeExecutor: ScheduleFlowExecutor = {
    async execute(_taskFlow, _scheduleId, lifecycle) {
      await lifecycle?.onBeforeStart?.();
      lifecycle?.onStarted?.();
      order.push('execute');
      return { success: true, stopped: false, message: '完成', summary: emptySummary };
    },
    getStatus: () => ({
      isRunning: false,
      scheduleId: null,
      runId: null,
      currentStep: -1,
      totalSteps: 0,
      currentTask: null,
      currentTaskId: null,
      message: '',
      startTime: null,
      shouldStop: false,
      lastResult: null,
      taskResults: []
    }),
    stop: () => false,
    async dispatchCompletion() {
      const run = listAgentRuns({ operationId: 'run_daily_flow' })[0];
      order.push(`dispatch:${run?.state || 'missing'}`);
      return { performed: true, errors: [] };
    }
  };

  const result = completedResult(await executeScheduledTaskFromCron(
    fastTaskFlow,
    'cron-completion-order',
    { executor: fakeExecutor }
  ));

  assert.equal(result.success, true);
  assert.deepEqual(order, ['execute', 'dispatch:succeeded']);
  const run = listAgentRuns({ operationId: 'run_daily_flow' })[0];
  assert.equal(run?.state, 'succeeded');
});

test('cron execution records one daily-flow run with its final result', async () => {
  const result = completedResult(await executeScheduledTaskFromCron(fastTaskFlow, 'cron-run'));

  assert.equal(result.success, true);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'succeeded');
  const runResult = dailyFlowResult(runs[0]);
  assert.equal(runResult.success, true);
  assert.equal(runResult.scheduleId, 'cron-run');
  assert.equal(runResult.totalSteps, 2);
  assert.equal(runResult.summary?.skippedCount, 2);
  assert.equal(runResult.summary?.taskResults.length, 2);
  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.equal(status.runId, null);
});

async function waitForCondition<T>(
  predicate: () => T | null | undefined | false,
  { timeout = 8000, interval = 20 } = {}
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('condition not met before timeout');
}

test('cron execution exposes one active run while it waits between steps', async () => {
  const closed = getTodayOpenStages().closed[0]?.stage;
  assert.ok(closed, 'expected at least one closed resource stage today');
  const taskFlow = [
    { id: 'fight-closed-1', commandId: 'fight', name: '理智作战', enabled: true, params: { stage: closed } },
    { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }
  ];

  const execution = executeScheduledTaskFromCron(taskFlow, 'cron-progress');
  const active: ScheduleExecutionStatus = await waitForCondition(() => {
    const status = getScheduleExecutionStatus();
    return status.isRunning && status.currentStep === 0 ? status : null;
  });

  assert.ok(active.runId);
  const snapshot = await buildAgentRunSnapshot();
  assert.ok(snapshot.run);
  // 日常流程的进度是进程/流程投影（带自己的 scheduleId），不是作业集会话进度。
  const progress = snapshot.run.progress;
  assert.ok(progress && 'scheduleId' in progress);
  assert.equal(snapshot.run.runId, active.runId);
  assert.equal(snapshot.run.state, 'running');
  assert.equal(progress.scheduleId, 'cron-progress');
  assert.equal(progress.currentStep, 0);
  assert.equal(progress.totalSteps, 2);
  assert.equal(snapshot.occupancy.state, 'run');
  assert.equal(getTaskStatus().isRunning, false);

  assert.equal(stopScheduleExecution(), true);
  const result = completedResult(await execution);

  assert.equal(result.stopped, true);
  const run = getAgentRun(active.runId);
  assert.equal(run?.state, 'stopped');
  const runResult = dailyFlowResult(run);
  assert.equal(runResult.stopped, true);
  assert.equal(runResult.scheduleId, 'cron-progress');
  assert.equal(runResult.totalSteps, 2);
});

test('cron execution fails closed when the device lease is held', async () => {
  await writeFile(lockFile, JSON.stringify({
    pid: process.pid,
    source: 'test-owner',
    taskName: '占用设备',
    command: 'copilot',
    startedAt: new Date().toISOString()
  }));

  const result = rejectedResult(await executeScheduledTaskFromCron(fastTaskFlow, 'cron-busy'));

  assert.equal(result.busy, true);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'failed');
  assert.ok(runs[0].error);
  assert.equal(runs[0].error.code, 'AGENT_EXECUTION_BUSY');
  assert.equal(getScheduleExecutionStatus().isRunning, false);
});

test('completed flows return task ids and retain skipped results in the polling snapshot', async () => {
  const taskFlow = [
    { id: 'infrast-1', commandId: 'infrast', name: '基建换班', enabled: true, params: { facility: [] } },
    { id: 'mall-disabled', commandId: 'mall', name: '信用收支', enabled: false, params: {} },
    { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} },
    { id: 'award-2', commandId: 'award', name: '领取奖励', enabled: true, params: {} },
  ];
  const result = completedResult(await executeScheduleNow('task-progress', taskFlow));
  const expected = taskFlow.filter(task => task.enabled).map(task => ({
    taskId: task.id, task: task.name, status: 'skipped'
  }));
  assert.equal(result.success, true);
  assert.deepEqual(result.summary.taskResults, expected);
  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.deepEqual(status.taskResults, expected);
  assert.deepEqual(status.lastResult?.taskResults, expected);
});

test('a stopped pre-start gate aborts the flow before any task runs', async () => {
  const rejection = Object.assign(new Error('执行在开始前已被停止'), {
    code: 'AGENT_RUN_STOPPED_BEFORE_START',
    stopped: true
  });
  const taskFlow = [{ id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }];

  await assert.rejects(
    executeScheduleNow('pre-start-stop', taskFlow, {
      onBeforeStart: async () => { throw rejection; }
    }),
    error => error === rejection
  );

  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.equal(status.scheduleId, null);
  assert.equal(status.totalSteps, 0);
  assert.match(status.message, /任务流程已被用户终止/);
  assert.deepEqual(status.taskResults, []);
});
