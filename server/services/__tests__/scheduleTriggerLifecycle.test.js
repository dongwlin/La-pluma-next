import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  attachScheduleTriggersToLifecycle,
  createScheduleTriggerRuntime,
  executeScheduledTaskFromCron,
  getScheduleExecutionStatus,
  stopScheduleExecution
} from '../schedulerService.js';
import { createRuntimeLifecycle } from '../runtimeLifecycleService.ts';
import { initializeRuntimeState } from '../runtimeInitializationService.js';
import { getAgentRun, listAgentRuns, resetAgentRunsForTests } from '../agentRunService.ts';
import { getTodayOpenStages } from '../notificationService.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

const taskFlow = [
  { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }
];

function createRecordingLogger() {
  const entries = [];
  const record = level => (message, data) => {
    entries.push({ level, message, data });
  };
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug')
  };
}

/**
 * 假 cron：createTask 只登记，start/stop/destroy 由测试或注册表调用。
 * failNext 用于模拟连续创建失败，验证失败时保留旧注册。
 */
function createFakeCron() {
  const cron = {
    tasks: [],
    failNext: 0,
    createTask(expression, callback, options) {
      if (cron.failNext > 0) {
        cron.failNext -= 1;
        throw new Error('cron unavailable');
      }
      const task = {
        expression,
        callback,
        options,
        started: false,
        destroyed: false,
        stopCalls: 0,
        start() {
          if (this.destroyed) throw new Error('cannot start a destroyed task');
          this.started = true;
        },
        stop() {
          this.started = false;
          this.stopCalls += 1;
        },
        destroy() {
          this.destroyed = true;
          this.started = false;
        }
      };
      cron.tasks.push(task);
      return task;
    }
  };
  return cron;
}

function createFakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    set(value) {
      current = value;
    },
    advance(ms) {
      current += ms;
    }
  };
}

function createRuntime({
  cronImpl = createFakeCron(),
  clock = createFakeClock(),
  ...overrides
} = {}) {
  const runtime = createScheduleTriggerRuntime({
    cronImpl,
    now: clock.now,
    runtimeLogger: silentLogger,
    runScheduleFlow: () => Promise.resolve(),
    runAutoUpdate: () => Promise.resolve(),
    ...overrides
  });
  return { runtime, fakeCron: cronImpl, clock };
}

describe('schedule trigger runtime', () => {
  it('replaces a duplicate schedule instead of accumulating jobs', () => {
    const { runtime, fakeCron } = createRuntime();

    const first = runtime.setupSchedule('default', ['12:00', '08:00', '08:00'], taskFlow);
    assert.equal(first.success, true);
    assert.deepEqual(first.times, ['12:00', '08:00']);
    const firstTasks = [...fakeCron.tasks];
    assert.equal(firstTasks.length, 2);
    assert.ok(firstTasks.every(task => task.started));
    assert.equal(fakeCron.tasks[0].expression, '00 12 * * *');

    const second = runtime.setupSchedule('default', ['09:30'], taskFlow);
    assert.equal(second.success, true);
    assert.deepEqual(second.times, ['09:30']);
    assert.ok(firstTasks.every(task => task.destroyed));
    assert.equal(fakeCron.tasks.length, 3);
    assert.equal(fakeCron.tasks[2].started, true);
    assert.deepEqual(runtime.getStatus(), [{ scheduleId: 'default', times: ['09:30'], count: 1 }]);
  });

  it('keeps exactly one registration when the same configuration is repeated', () => {
    const { runtime, fakeCron } = createRuntime();

    assert.equal(runtime.setupSchedule('default', ['08:00', '12:00'], taskFlow).success, true);
    const firstTasks = [...fakeCron.tasks];
    assert.equal(runtime.setupSchedule('default', ['08:00', '12:00'], taskFlow).success, true);

    assert.equal(firstTasks.every(task => task.destroyed), true);
    assert.equal(fakeCron.tasks.filter(task => task.started).length, 2);
    const status = runtime.getStatus();
    assert.equal(status.length, 1);
    assert.deepEqual(status[0], { scheduleId: 'default', times: ['08:00', '12:00'], count: 2 });
  });

  it('rejects invalid input without touching the active registration', () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    const active = fakeCron.tasks[0];

    assert.deepEqual(runtime.setupSchedule('default', [], taskFlow), {
      success: false,
      message: '没有设置执行时间'
    });
    assert.deepEqual(runtime.setupSchedule('default', ['08:00'], 'not-a-flow'), {
      success: false,
      message: '任务流程格式无效'
    });

    assert.equal(active.destroyed, false);
    assert.deepEqual(runtime.getStatus(), [{ scheduleId: 'default', times: ['08:00'], count: 1 }]);
  });

  it('keeps the previous registration when every new job fails', () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupSchedule('default', ['08:00', '12:00'], taskFlow);
    const active = [...fakeCron.tasks];

    fakeCron.failNext = 2;
    const result = runtime.setupSchedule('default', ['09:00', '10:00'], taskFlow);

    assert.deepEqual(result, { success: false, message: '没有成功设置任何定时任务' });
    assert.equal(active.some(task => task.destroyed), false);
    assert.deepEqual(runtime.getStatus(), [{ scheduleId: 'default', times: ['08:00', '12:00'], count: 2 }]);
  });

  it('installs only the created time points when part of the new schedule fails', () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    const previous = fakeCron.tasks[0];

    fakeCron.failNext = 1;
    const result = runtime.setupSchedule('default', ['09:00', '10:00'], taskFlow);

    assert.equal(result.success, true);
    assert.deepEqual(result.times, ['10:00']);
    assert.equal(previous.destroyed, true);
    assert.deepEqual(runtime.getStatus(), [{ scheduleId: 'default', times: ['10:00'], count: 1 }]);
  });

  it('stops one schedule idempotently and leaves other registrations alone', () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    runtime.setupSchedule('weekend', ['10:00'], taskFlow);
    const [defaultTask, weekendTask] = fakeCron.tasks;

    assert.deepEqual(runtime.stopSchedule('default'), { success: true, message: '定时任务已停止' });
    assert.equal(defaultTask.destroyed, true);
    assert.equal(weekendTask.destroyed, false);
    assert.deepEqual(runtime.stopSchedule('default'), { success: true, message: '定时任务已停止' });
    assert.deepEqual(runtime.getStatus(), [{ scheduleId: 'weekend', times: ['10:00'], count: 1 }]);
  });

  it('destroys every trigger once and refuses new registrations afterwards', () => {
    const clock = createFakeClock(2_000);
    const { runtime, fakeCron } = createRuntime({ clock });
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    runtime.setupAutoUpdate({ enabled: true, time: '03:00', updateCore: true });
    const tasks = [...fakeCron.tasks];

    const firstSummary = runtime.stopAll('test-close');
    assert.equal(firstSummary.ok, true);
    assert.equal(firstSummary.reason, 'test-close');
    assert.equal(firstSummary.stoppedAt, 2_000);
    assert.equal(firstSummary.durationMs, 0);
    assert.deepEqual(firstSummary.stopped.map(entry => entry.scheduleId), ['default', 'auto-update']);
    assert.ok(tasks.every(task => task.destroyed));

    clock.advance(500);
    assert.equal(runtime.stopAll('again'), firstSummary);
    assert.equal(runtime.describe().closed, true);

    assert.deepEqual(runtime.setupSchedule('default', ['08:00'], taskFlow), {
      success: false,
      message: '运行时正在关闭，无法设置定时任务'
    });
    assert.deepEqual(runtime.setupAutoUpdate({ enabled: true, time: '03:00' }), {
      success: false,
      message: '运行时正在关闭，无法设置自动更新'
    });
  });

  it('drops callbacks queued before reconfiguration or stop', () => {
    const calls = [];
    const { runtime, fakeCron } = createRuntime({
      runScheduleFlow: (flow, scheduleId) => {
        calls.push({ flow, scheduleId });
        return Promise.resolve();
      }
    });
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    const staleTask = fakeCron.tasks[0];

    runtime.setupSchedule('default', ['09:00'], taskFlow);
    staleTask.callback();
    assert.deepEqual(calls, []);
    assert.equal(runtime.describe().counters.skippedStale, 1);

    const currentTask = fakeCron.tasks[1];
    currentTask.callback();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scheduleId, 'default-0');

    runtime.stopSchedule('default');
    currentTask.callback();
    assert.equal(calls.length, 1);
    assert.equal(runtime.describe().counters.skippedStale, 2);
  });

  it('drops queued callbacks and records the fake clock once draining starts', () => {
    const clock = createFakeClock(10_000);
    const logger = createRecordingLogger();
    let draining = false;
    const calls = [];
    const fakeCron = createFakeCron();
    const runtime = createScheduleTriggerRuntime({
      cronImpl: fakeCron,
      now: clock.now,
      runtimeLogger: logger,
      runScheduleFlow: () => {
        calls.push('run');
        return Promise.resolve();
      },
      isDraining: () => draining
    });
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    const task = fakeCron.tasks[0];

    draining = true;
    clock.set(11_500);
    task.callback();

    assert.deepEqual(calls, []);
    assert.deepEqual(runtime.setupSchedule('default', ['09:00'], taskFlow), {
      success: false,
      message: '运行时正在关闭，无法设置定时任务'
    });
    const skip = logger.entries.find(entry => entry.message === '运行时正在关闭，忽略已排队的定时触发');
    assert.deepEqual(skip.data, { scheduleId: 'default-0', time: '08:00', at: 11_500 });
    assert.equal(runtime.describe().counters.skippedDraining, 1);
  });

  it('registers auto-update without executing it and drops it while draining', () => {
    let draining = false;
    const updates = [];
    const { runtime, fakeCron } = createRuntime({
      runAutoUpdate: config => {
        updates.push(config);
        return Promise.resolve();
      },
      isDraining: () => draining
    });

    const result = runtime.setupAutoUpdate({ enabled: true, time: '03:00', updateCore: true });
    assert.equal(result.success, true);
    assert.deepEqual(runtime.getAutoUpdateStatus(), { enabled: true, time: '03:00' });
    assert.deepEqual(updates, []);

    draining = true;
    fakeCron.tasks[0].callback();
    assert.deepEqual(updates, []);
    assert.deepEqual(runtime.setupAutoUpdate({ enabled: true, time: '04:00' }), {
      success: false,
      message: '运行时正在关闭，无法设置自动更新'
    });

    draining = false;
    fakeCron.tasks[0].callback();
    assert.deepEqual(updates, [{ enabled: true, time: '03:00', updateCore: true }]);
  });

  it('keeps the active auto-update registration on invalid input and clears it on disable', () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupAutoUpdate({ enabled: true, time: '03:00' });
    const active = fakeCron.tasks[0];

    assert.deepEqual(runtime.setupAutoUpdate({ enabled: true, time: '03:00', updateCore: true }), {
      success: true,
      message: '自动更新已设置，每天 03:00 执行',
      config: { enabled: true, time: '03:00', updateCore: true }
    });
    assert.equal(active.destroyed, true);

    const current = fakeCron.tasks[1];
    assert.deepEqual(runtime.setupAutoUpdate({ enabled: true, time: 'not-a-time' }), {
      success: false,
      message: '时间格式错误'
    });
    assert.equal(current.destroyed, false);
    assert.deepEqual(runtime.getAutoUpdateStatus(), { enabled: true, time: '03:00' });

    assert.deepEqual(runtime.setupAutoUpdate({ enabled: false }), {
      success: false,
      message: '自动更新未启用'
    });
    assert.deepEqual(runtime.setupAutoUpdate({ enabled: false }), {
      success: false,
      message: '自动更新未启用'
    });
    assert.equal(current.destroyed, true);
    assert.deepEqual(runtime.getAutoUpdateStatus(), { enabled: false, time: null });
  });
});

function createFakeLifecycle() {
  let draining = false;
  const steps = [];
  return {
    steps,
    register(step) {
      steps.push(step);
    },
    isDraining: () => draining,
    async close() {
      draining = true;
      const results = [];
      for (const step of [...steps].reverse()) {
        try {
          await step.close?.();
          results.push({ name: step.name, status: 'closed' });
        } catch (error) {
          results.push({ name: step.name, status: 'failed', error: error.message });
        }
      }
      return { ok: results.every(result => result.status === 'closed'), steps: results };
    }
  };
}

describe('schedule trigger runtime lifecycle', () => {
  it('registers one close step and stops every trigger when the runtime closes', async () => {
    const fakeCron = createFakeCron();
    const clock = createFakeClock();
    const logger = createRecordingLogger();
    const runtime = createScheduleTriggerRuntime({
      cronImpl: fakeCron,
      now: clock.now,
      runtimeLogger: logger,
      runScheduleFlow: () => Promise.resolve()
    });
    const lifecycle = createRuntimeLifecycle({
      logger: silentLogger,
      closeDeadlineMs: 1_000,
      now: clock.now
    });

    assert.deepEqual(attachScheduleTriggersToLifecycle(lifecycle, runtime), {
      attached: true,
      duplicate: false
    });
    assert.deepEqual(attachScheduleTriggersToLifecycle(lifecycle, runtime), {
      attached: true,
      duplicate: true
    });

    runtime.setupSchedule('default', ['08:00'], taskFlow);
    await lifecycle.start();
    const task = fakeCron.tasks[0];

    const closing = lifecycle.close('test-close');
    assert.equal(lifecycle.isDraining(), true);
    task.callback();
    assert.equal(runtime.describe().counters.skippedDraining, 1);

    const summary = await closing;
    assert.equal(summary.ok, true);
    assert.equal(summary.steps.find(step => step.name === 'scheduled-triggers').status, 'closed');
    assert.equal(task.destroyed, true);
    assert.equal(runtime.describe().closed, true);
  });

  it('still registers the stop port when the lifecycle has no draining predicate', async () => {
    const runtime = createRuntime().runtime;
    const steps = [];
    const lifecycle = {
      register(step) {
        steps.push(step);
      }
    };

    assert.deepEqual(attachScheduleTriggersToLifecycle(lifecycle, runtime), {
      attached: true,
      duplicate: false
    });
    assert.deepEqual(steps.map(step => step.name), ['scheduled-triggers']);
    assert.equal(attachScheduleTriggersToLifecycle(null, runtime).attached, false);
    await steps[0].close();
    assert.equal(runtime.describe().closed, true);
  });

  it('binds the drain predicate even when the lifecycle already refuses new steps', async () => {
    const { runtime } = createRuntime();
    const lifecycle = createRuntimeLifecycle({
      logger: silentLogger,
      closeDeadlineMs: 1_000
    });
    await lifecycle.start();
    await lifecycle.close('early-close');

    assert.throws(
      () => attachScheduleTriggersToLifecycle(lifecycle, runtime),
      error => error.code === 'RUNTIME_LIFECYCLE_CLOSED'
    );
    assert.equal(runtime.describe().draining, true);
    assert.deepEqual(runtime.setupSchedule('default', ['08:00'], taskFlow), {
      success: false,
      message: '运行时正在关闭，无法设置定时任务'
    });
  });

  it('reports destroy failures through the lifecycle step without skipping later cleanup', async () => {
    const { runtime, fakeCron } = createRuntime();
    runtime.setupSchedule('default', ['08:00'], taskFlow);
    fakeCron.tasks[0].destroy = () => {
      throw new Error('destroy failed');
    };
    const lifecycle = createFakeLifecycle();
    const laterSteps = [];
    lifecycle.register({ name: 'later-cleanup', close: () => laterSteps.push('closed') });
    attachScheduleTriggersToLifecycle(lifecycle, runtime);

    const summary = await lifecycle.close();
    assert.equal(summary.ok, false);
    assert.equal(summary.steps.find(step => step.name === 'scheduled-triggers').status, 'failed');
    assert.match(summary.steps.find(step => step.name === 'scheduled-triggers').error, /destroy failed/);
    assert.deepEqual(laterSteps, ['closed']);
    assert.equal(runtime.describe().closeSummary.ok, false);
    assert.equal(runtime.describe().closed, true);
  });

  it('restores persisted triggers without executing them and stops them on close', async () => {
    const fakeCron = createFakeCron();
    const clock = createFakeClock(5_000);
    const runs = [];
    const runtime = createScheduleTriggerRuntime({
      cronImpl: fakeCron,
      now: clock.now,
      runtimeLogger: silentLogger,
      runScheduleFlow: (flow, scheduleId) => {
        runs.push(['schedule', scheduleId]);
        return Promise.resolve();
      },
      runAutoUpdate: config => {
        runs.push(['auto-update', config]);
        return Promise.resolve();
      }
    });
    const lifecycle = createRuntimeLifecycle({
      logger: silentLogger,
      closeDeadlineMs: 1_000,
      now: clock.now
    });
    const persisted = {
      'automation-tasks': {
        taskFlow: [{ id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }],
        schedule: { enabled: true, times: ['04:30', '12:00'] }
      },
      'auto-update': { enabled: true, time: '03:00', updateCore: true }
    };

    lifecycle.register({
      name: 'runtime-initialization',
      start: () => initializeRuntimeState({
        lifecycle,
        attachScheduleLifecycle: target => attachScheduleTriggersToLifecycle(target, runtime),
        loadConfig: async configType => ({ success: true, data: persisted[configType] || null }),
        readNotificationConfig: () => ({ channels: {} }),
        registerSchedule: (scheduleId, times, taskFlowToRun) => runtime.setupSchedule(scheduleId, times, taskFlowToRun),
        registerAutoUpdate: config => runtime.setupAutoUpdate(config),
        resolveRuntimeConnection: async () => ({}),
        startTelegramBot: () => {},
        runtimeLogger: silentLogger
      })
    });
    const startSummary = await lifecycle.start();
    assert.deepEqual(startSummary.started, ['runtime-initialization', 'scheduled-triggers']);

    assert.equal(fakeCron.tasks.length, 3);
    assert.ok(fakeCron.tasks.every(task => task.started));
    assert.deepEqual(runs, []);
    assert.deepEqual(runtime.getStatus(), [
      { scheduleId: 'default', times: ['04:30', '12:00'], count: 2 },
      { scheduleId: 'auto-update', times: ['03:00'], count: 1 }
    ]);
    assert.deepEqual(runtime.getAutoUpdateStatus(), { enabled: true, time: '03:00' });
    assert.deepEqual(
      runtime.describe().registrations.map(entry => entry.registeredAt),
      [5_000, 5_000]
    );

    const summary = await lifecycle.close('test-close');
    assert.equal(summary.ok, true);
    assert.ok(fakeCron.tasks.every(task => task.destroyed));
    assert.equal(runtime.describe().closed, true);
    assert.deepEqual(runs, []);
  });
});

describe('scheduled flow shutdown', () => {
  let testDir;
  let lockFile;

  before(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'la-pluma-schedule-trigger-'));
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

  async function waitForCondition(predicate, { timeout = 8000, interval = 20 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error('condition not met before timeout');
  }

  it('leaves an active flow terminal state to the execution after triggers stop', async () => {
    const closedStage = getTodayOpenStages().closed[0]?.stage;
    assert.ok(closedStage, 'expected at least one closed resource stage today');
    const flow = [
      { id: 'fight-closed-1', commandId: 'fight', name: '理智作战', enabled: true, params: { stage: closedStage } },
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }
    ];
    const fakeCron = createFakeCron();
    let execution;
    const runtime = createScheduleTriggerRuntime({
      cronImpl: fakeCron,
      runtimeLogger: silentLogger,
      runScheduleFlow: (taskFlowToRun, scheduleId) => {
        execution = executeScheduledTaskFromCron(taskFlowToRun, scheduleId);
        return execution;
      }
    });
    runtime.setupSchedule('default', ['04:00'], flow);
    const scheduledTask = fakeCron.tasks[0];

    scheduledTask.callback();
    const active = await waitForCondition(() => {
      const status = getScheduleExecutionStatus();
      return status.isRunning && status.currentStep === 0 ? status : null;
    });
    assert.ok(active.runId);
    assert.equal(getAgentRun(active.runId).state, 'running');

    const summary = runtime.stopAll('test-close');
    assert.equal(summary.ok, true);
    assert.equal(scheduledTask.destroyed, true);
    assert.equal(getScheduleExecutionStatus().isRunning, true);
    assert.equal(getAgentRun(active.runId).state, 'running');
    assert.equal(listAgentRuns({ operationId: 'run_daily_flow' }).length, 1);

    scheduledTask.callback();
    assert.equal(listAgentRuns({ operationId: 'run_daily_flow' }).length, 1);

    assert.equal(stopScheduleExecution(), true);
    const result = await execution;
    assert.equal(result.stopped, true);
    const run = getAgentRun(active.runId);
    assert.equal(run.state, 'stopped');
    assert.equal(run.result.stopped, true);
  });
});
