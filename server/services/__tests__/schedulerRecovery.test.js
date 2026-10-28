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
} from '../schedulerService.js';
import { getAgentRun, listAgentRuns, resetAgentRunsForTests } from '../agentRunService.ts';
import { buildAgentRunSnapshot } from '../runSnapshotService.js';
import { getTaskStatus } from '../maaProcessService.ts';
import { getTodayOpenStages } from '../notificationService.js';

let testDir;
let lockFile;

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

  assert.equal(result.success, false);
  assert.match(result.message, /split/);
  assert.equal(getScheduleExecutionStatus().isRunning, false);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'failed');
  assert.match(runs[0].error.message, /split/);
});

test('cron execution records one daily-flow run with its final result', async () => {
  const result = await executeScheduledTaskFromCron(fastTaskFlow, 'cron-run');

  assert.equal(result.success, true);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'succeeded');
  assert.equal(runs[0].result.success, true);
  assert.equal(runs[0].result.scheduleId, 'cron-run');
  assert.equal(runs[0].result.totalSteps, 2);
  assert.equal(runs[0].result.summary.skippedCount, 2);
  assert.equal(runs[0].result.summary.taskResults.length, 2);
  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.equal(status.runId, null);
});

async function waitForCondition(predicate, { timeout = 8000, interval = 20 } = {}) {
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
  const active = await waitForCondition(() => {
    const status = getScheduleExecutionStatus();
    return status.isRunning && status.currentStep === 0 ? status : null;
  });

  assert.ok(active.runId);
  const snapshot = await buildAgentRunSnapshot();
  assert.equal(snapshot.run.runId, active.runId);
  assert.equal(snapshot.run.state, 'running');
  assert.equal(snapshot.run.progress.scheduleId, 'cron-progress');
  assert.equal(snapshot.run.progress.currentStep, 0);
  assert.equal(snapshot.run.progress.totalSteps, 2);
  assert.equal(snapshot.occupancy.state, 'run');
  assert.equal(getTaskStatus().isRunning, false);

  assert.equal(stopScheduleExecution(), true);
  const result = await execution;

  assert.equal(result.stopped, true);
  const run = getAgentRun(active.runId);
  assert.equal(run.state, 'stopped');
  assert.equal(run.result.stopped, true);
  assert.equal(run.result.scheduleId, 'cron-progress');
  assert.equal(run.result.totalSteps, 2);
});

test('cron execution fails closed when the device lease is held', async () => {
  await writeFile(lockFile, JSON.stringify({
    pid: process.pid,
    source: 'test-owner',
    taskName: '占用设备',
    command: 'copilot',
    startedAt: new Date().toISOString()
  }));

  const result = await executeScheduledTaskFromCron(fastTaskFlow, 'cron-busy');

  assert.equal(result.success, false);
  assert.equal(result.busy, true);
  const runs = listAgentRuns({ operationId: 'run_daily_flow' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'failed');
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
  const result = await executeScheduleNow('task-progress', taskFlow);
  const expected = taskFlow.filter(task => task.enabled).map(task => ({
    taskId: task.id, task: task.name, status: 'skipped'
  }));
  assert.equal(result.success, true);
  assert.deepEqual(result.summary.taskResults, expected);
  const status = getScheduleExecutionStatus();
  assert.equal(status.isRunning, false);
  assert.deepEqual(status.taskResults, expected);
  assert.deepEqual(status.lastResult.taskResults, expected);
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
