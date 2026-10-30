import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScheduleFlowExecutor } from '../scheduleFlowExecution.ts';
import type {
  ScheduleExecutionPorts,
  ScheduleFlowCompletedResult,
  ScheduleFlowExecutionResult
} from '../scheduleFlowExecution.ts';
import { buildScheduledTaskFlowPlan, validateScheduledTaskFlow } from '../scheduleFlowPlan.ts';
import type { ScheduledTaskFlowPlanResult } from '../scheduleFlowPlan.ts';
import { buildFlowExecutionOutcome, getFightReportResults, parseTaskSummary } from '../scheduleFlowResult.ts';
import type { TaskCompletionInfo } from '../notificationService.ts';
import type { DropRecordInput } from '../dropRecordService.ts';
import type { MaaExecutionLeaseRequest } from '../executionCoordinatorService.ts';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  success() {}
};

function plannedResult(result: ScheduledTaskFlowPlanResult) {
  if (!result.success) throw new Error(result.message);
  return result;
}

function completedResult(result: ScheduleFlowExecutionResult): ScheduleFlowCompletedResult {
  if (!result.success) throw new Error(result.message);
  return result;
}

function createPorts(overrides: Partial<ScheduleExecutionPorts> = {}) {
  const calls = {
    commands: [] as Array<{ command: string; args: readonly string[]; taskName: string | null }>,
    dynamicTasks: [] as Array<{ taskId: string; taskConfig: string; taskName: string | null }>,
    checkpoints: 0,
    reads: 0,
    notifications: [] as TaskCompletionInfo[],
    notificationLeaseStates: [] as boolean[],
    drops: [] as DropRecordInput[],
    refreshes: [] as string[],
    leases: [] as MaaExecutionLeaseRequest[]
  };
  let leaseActive = false;

  const ports: ScheduleExecutionPorts = {
    executeCommand: async (command, args, taskName) => {
      calls.commands.push({ command, args, taskName });
      return { stdout: '', stderr: '' };
    },
    executeDynamicTask: async (taskId, taskConfig, taskName) => {
      calls.dynamicTasks.push({ taskId, taskConfig, taskName });
      return { stdout: '', stderr: '' };
    },
    createLogCheckpoint: async () => {
      calls.checkpoints += 1;
      return { logPath: 'asst.log', size: 0 };
    },
    readLogSince: async () => {
      calls.reads += 1;
      return 'log-1';
    },
    resolveConnection: async () => ({ adbPath: 'adb', address: '127.0.0.1:5555' }),
    testConnection: async () => ({ success: true }),
    getGameClientState: async () => ({ running: true, foregroundPackage: 'com.hypergryph.arknights' }),
    captureScreen: async () => ({ image: 'fake-image' }),
    replaceActivityCode: async stage => stage,
    isStageOpenToday: () => ({ isOpen: true }),
    shouldCaptureNotificationScreenshot: () => false,
    sendCompletionNotification: async payload => {
      calls.notifications.push(payload);
      calls.notificationLeaseStates.push(leaseActive);
    },
    recordDrops: async payload => {
      calls.drops.push(payload);
    },
    parseDepotData: async () => ({ success: true, itemCount: 0 }),
    refreshSmartTrainingStages: async scheduleId => {
      calls.refreshes.push(scheduleId);
    },
    withExecutionLease: async <T>(context: MaaExecutionLeaseRequest, run: () => Promise<T>): Promise<T> => {
      calls.leases.push(context);
      leaseActive = true;
      try {
        return await run();
      } finally {
        leaseActive = false;
      }
    },
    ...overrides
  };

  return { ports, calls };
}


function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition<T>(
  predicate: () => T | null | undefined | false,
  { timeout = 5_000, interval = 5 } = {}
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('condition not met before timeout');
}

describe('schedule flow boundaries', () => {
  it('plans commands and aggregates results without device, storage or notification ports', () => {
    const plan = plannedResult(buildScheduledTaskFlowPlan([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 3, drops: '30011=10' }
      },
      {
        id: 'recruit-1',
        commandId: 'recruit',
        name: '自动公招',
        enabled: true,
        taskType: 'Recruit',
        params: { times: '4' }
      }
    ]));

    const steps = plan.steps;
    assert.equal(plan.totalSteps, 2);
    assert.deepEqual(steps[0].args, ['1-7:3', '-D30011=10']);
    assert.equal(steps[1].command, 'run');
    assert.equal(steps[1].dynamicTask, true);

    assert.deepEqual(validateScheduledTaskFlow(null), { success: false, message: '任务流程格式无效' });
    assert.equal(validateScheduledTaskFlow([{ id: 'fight-1', commandId: 'fight', params: { drops: 'bad' } }]).success, false);

    const summary = parseTaskSummary('理智作战', 'Fight 1-7 3 times, total drops: 龙门币 × 252');
    assert.ok(summary);
    assert.equal(summary.stage, '1-7');
    assert.equal(summary.times, '3');
    assert.deepEqual(summary.dropItems, [{ name: '龙门币', count: 252 }]);

    const { reportResults } = getFightReportResults(
      { params: { report_to_penguin: true } },
      '1-7',
      { stdout: 'Fight 1-7 3 times', stderr: '' }
    );
    assert.deepEqual(reportResults, [{
      provider: 'penguin',
      stage: '1-7',
      status: 'success',
      message: '已汇报至企鹅物流'
    }]);

    const outcome = buildFlowExecutionOutcome({
      successCount: 1,
      failedCount: 2,
      skippedCount: 0,
      durationMs: 1_000,
      wasStopped: false,
      summaries: [],
      reports: [{ provider: 'penguin', stage: '1-7', status: 'failed', message: '企鹅物流汇报失败' }],
      actions: [],
      errors: [],
      warnings: [],
      taskResults: []
    });
    assert.equal(outcome.completionMessage, '任务流程执行完成，1 项掉落汇报失败');
    assert.equal(outcome.executionSummary.failedCount, 2);

    const baseOutcome = {
      successCount: 0,
      failedCount: 2,
      skippedCount: 0,
      durationMs: 0,
      wasStopped: false,
      summaries: [],
      reports: [],
      actions: [],
      errors: [],
      warnings: [],
      taskResults: []
    };
    assert.equal(
      buildFlowExecutionOutcome({ ...baseOutcome, wasStopped: true }).completionMessage,
      '任务流程已被用户终止'
    );
    assert.equal(
      buildFlowExecutionOutcome(baseOutcome).completionMessage,
      '任务流程执行完成，2 项任务失败'
    );
    assert.equal(
      buildFlowExecutionOutcome({ ...baseOutcome, failedCount: 0 }).completionMessage,
      '任务流程执行完成'
    );
  });

  it('refuses to create an executor without the required ports', () => {
    assert.throws(
      () => createScheduleFlowExecutor({ ports: {}, logger: silentLogger }),
      /缺少执行端口/
    );
  });

  it('runs steps through injected ports and keeps success, skipped and failed apart', async () => {
    const { ports, calls } = createPorts({
      executeCommand: async (command, args, taskName) => {
        calls.commands.push({ command, args, taskName });
        if (command === 'throw') throw new Error('命令执行失败');
        return { stdout: '', stderr: '' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const taskFlow = [
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } },
      { id: 'infrast-1', commandId: 'infrast', name: '基建换班', enabled: true, params: { facility: [] } },
      { id: 'broken-1', commandId: 'throw', name: '失败任务', enabled: true, params: {} }
    ];

    const result = completedResult(await executor.execute(taskFlow, 'flow-ports'));

    assert.equal(result.stopped, false);
    assert.equal(result.summary.successCount, 1);
    assert.equal(result.summary.skippedCount, 1);
    assert.equal(result.summary.failedCount, 1);
    assert.deepEqual(result.summary.taskResults.map(task => task.status), ['success', 'skipped', 'failed']);

    assert.equal(calls.checkpoints, 1);
    assert.equal(calls.reads, 1);
    assert.deepEqual(calls.commands.map(call => call.command), ['award', 'throw']);
    assert.equal(calls.leases.length, 1);
    assert.equal(calls.leases[0].source, 'schedule');

    // 执行期间只准备通知载荷，不能在租约内调用通知或养成回写。
    assert.equal(calls.refreshes.length, 0);
    assert.equal(calls.notifications.length, 0);
    const completion = await executor.dispatchCompletion(result);
    assert.equal(completion.performed, true);
    assert.deepEqual(completion.errors, []);
    assert.equal(calls.refreshes.length, 1);
    assert.equal(calls.refreshes[0], 'flow-ports');
    assert.equal(calls.notifications.length, 1);
    assert.deepEqual(calls.notificationLeaseStates, [false]);
    assert.equal(calls.notifications[0].totalTasks, 3);
    assert.equal(calls.notifications[0].successTasks, 1);
    assert.equal(calls.notifications[0].failedTasks, 1);
    assert.equal(calls.notifications[0].skippedTasks, 1);

    const status = executor.getStatus();
    assert.equal(status.isRunning, false);
    assert.equal(status.scheduleId, null);
    assert.deepEqual(status.lastResult, result.summary);
  });


  it('aborts the closedown pre-depot delay when the flow is stopped', async () => {
    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const execution = executor.execute([
      { id: 'closedown-1', commandId: 'closedown', name: '关闭游戏', enabled: true, params: { recognizeDepotBeforeClose: true } },
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-delay-closedown-first');

    await waitForCondition(() => executor.getStatus().currentTask === '关闭游戏');
    const stoppedAt = Date.now();
    assert.equal(executor.stop(), true);

    const result = completedResult(await execution);
    assert.equal(result.stopped, true);
    assert.ok(Date.now() - stoppedAt < 1_000, 'the 3s pre-depot delay must abort on stop');
    assert.equal(calls.dynamicTasks.length, 0, 'a stopped flow must not start depot recognition');
    assert.equal(calls.commands.length, 0, 'a stopped flow must not run the closedown command or the next task');
  });

  it('aborts the closedown post-depot delay when the flow is stopped', async () => {
    const parsed = deferred<{ success: boolean; itemCount: number }>();
    let parseStarted = false;
    const { ports, calls } = createPorts({
      parseDepotData: async () => {
        parseStarted = true;
        return parsed.promise;
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const execution = executor.execute([
      { id: 'closedown-1', commandId: 'closedown', name: '关闭游戏', enabled: true, params: { recognizeDepotBeforeClose: true } },
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-delay-closedown-second');

    await waitForCondition(() => parseStarted);
    const stoppedAt = Date.now();
    assert.equal(executor.stop(), true);
    parsed.resolve({ success: true, itemCount: 0 });

    const result = completedResult(await execution);
    assert.equal(result.stopped, true);
    assert.ok(Date.now() - stoppedAt < 1_000, 'the 2s post-depot delay must abort on stop');
    assert.equal(calls.commands.length, 0, 'a stopped flow must not run the closedown command or the next task');
  });

  it('aborts the startup retry delay when the flow is stopped', async () => {
    const firstCommand = deferred<{ stdout: string; stderr: string }>();
    let startupAttempts = 0;
    const { ports, calls } = createPorts({
      executeCommand: async (command, args, taskName) => {
        calls.commands.push({ command, args, taskName });
        if (command === 'startup') {
          startupAttempts += 1;
          if (startupAttempts === 1) return firstCommand.promise;
        }
        return { stdout: '', stderr: '' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const execution = executor.execute([
      { id: 'startup-1', commandId: 'startup', name: '启动游戏', enabled: true, params: {} },
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-delay-startup');

    await waitForCondition(() => startupAttempts === 1);
    const stoppedAt = Date.now();
    assert.equal(executor.stop(), true);
    firstCommand.reject(new Error('startup stopped'));

    const result = completedResult(await execution);
    assert.equal(result.stopped, true);
    assert.ok(Date.now() - stoppedAt < 1_000, 'the 3s startup retry delay must abort on stop');
    assert.equal(startupAttempts, 1, 'a stopped startup must not enter another retry');
  });

  it('aborts the skipped-stage delay when the flow is stopped', async () => {
    const openCheck = deferred<{ isOpen: boolean; reason: string }>();
    const checks: string[] = [];
    const { ports, calls } = createPorts({
      isStageOpenToday: stage => {
        checks.push(stage);
        return openCheck.promise;
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const execution = executor.execute([
      { id: 'fight-1', commandId: 'fight', name: '理智作战', enabled: true, params: { stage: '1-7', times: 1 } },
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-delay-stage');

    await waitForCondition(() => checks.length === 1);
    const stoppedAt = Date.now();
    assert.equal(executor.stop(), true);
    openCheck.resolve({ isOpen: false, reason: '今日未开放' });

    const result = completedResult(await execution);
    assert.equal(result.stopped, true);
    assert.ok(Date.now() - stoppedAt < 1_000, 'the 2s skipped-stage delay must abort on stop');
    assert.equal(calls.commands.length, 0, 'a stopped flow must not start the next task');
  });

  it('reports completion side-effect failures after the lease and consumes the completion once', async () => {
    const { ports } = createPorts({
      refreshSmartTrainingStages: async () => {
        throw new Error('config write failed');
      },
      sendCompletionNotification: async () => {
        throw new Error('telegram timeout');
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const result = completedResult(await executor.execute([
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-completion-errors'));

    const completion = await executor.dispatchCompletion(result);
    assert.deepEqual(completion, {
      performed: true,
      errors: [
        '动态更新智能养成关卡失败: config write failed',
        '发送通知失败: telegram timeout'
      ]
    });
    assert.deepEqual(await executor.dispatchCompletion(result), { performed: false, errors: [] });
  });

  it('keeps a single execution owner and stops before the next step', async () => {
    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const taskFlow = [
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } },
      { id: 'award-2', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ];

    const execution = executor.execute(taskFlow, 'flow-stop');
    await waitForCondition(() => calls.commands.length === 1 && executor.getStatus().currentStep === 0);

    const duplicate = await executor.execute(taskFlow, 'flow-stop-duplicate');
    assert.deepEqual(duplicate, { success: false, message: '已有任务流程正在执行' });

    assert.equal(executor.stop(), true);
    const result = completedResult(await execution);

    assert.equal(result.stopped, true);
    assert.equal(result.summary.successCount, 1);
    assert.deepEqual(result.summary.taskResults.map(task => task.status), ['success', 'pending']);
    assert.equal(calls.commands.length, 1, 'the queued task must not start after the stop');
    const completion = await executor.dispatchCompletion(result);
    assert.equal(completion.performed, false);
    assert.equal(calls.notifications.length, 0, 'stopped flows skip the completion notification');

    const status = executor.getStatus();
    assert.equal(status.isRunning, false);
    assert.equal(status.shouldStop, false);
    assert.equal(status.message, '任务流程已被用户终止');
  });

  it('uses the connection client type for stage open checks unless the task overrides it', async () => {
    const checks: Array<{ stage: string; clientType: string }> = [];
    const { ports, calls } = createPorts({
      resolveConnection: async () => ({
        adbPath: 'adb',
        address: '127.0.0.1:5555',
        clientType: 'YoStarJP'
      }),
      isStageOpenToday: (stage, clientType) => {
        checks.push({ stage, clientType });
        return { isOpen: false, reason: '今日未开放' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    const fromProfile = completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: 'CE-6', times: '1' }] }
      }
    ], 'flow-client-profile'));

    assert.deepEqual(checks, [{ stage: 'CE-6', clientType: 'YoStarJP' }]);
    assert.equal(fromProfile.summary.skippedCount, 1);
    assert.equal(calls.commands.length, 0);

    checks.length = 0;
    await completedResult(await executor.execute([
      {
        id: 'fight-2',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: 'CE-6', times: '1' }], clientType: 'Bilibili' }
      }
    ], 'flow-client-override'));

    assert.deepEqual(checks, [{ stage: 'CE-6', clientType: 'Bilibili' }]);
  });

  it('awaits asynchronous stage open checks before executing or skipping stages', async () => {
    const checks: string[] = [];
    const { ports, calls } = createPorts({
      isStageOpenToday: async stage => {
        checks.push(stage);
        return { isOpen: false, reason: '资源本今日未开放' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    const multiStage = completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: 'CE-6', times: '1' }, { stage: 'AP-5', times: '1' }] }
      }
    ], 'flow-async-multi'));
    assert.deepEqual(checks, ['CE-6', 'AP-5']);
    assert.equal(multiStage.summary.skippedCount, 1);
    assert.deepEqual(multiStage.summary.taskResults.map(task => task.status), ['skipped']);
    assert.equal(calls.commands.length, 0);

    checks.length = 0;
    const singleStage = completedResult(await executor.execute([
      {
        id: 'fight-2',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: 'SK-5', times: '1' }] }
      }
    ], 'flow-async-single'));
    assert.deepEqual(checks, ['SK-5']);
    assert.equal(singleStage.summary.skippedCount, 1);
    assert.equal(calls.commands.length, 0);
  });

  it('keeps the selected series when a single stage also sets times', async () => {
    const taskFlow = [
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: '1-7', times: 12 }], series: 6 }
      }
    ];

    const plan = plannedResult(buildScheduledTaskFlowPlan(taskFlow));
    assert.deepEqual(plan.steps[0].args, ['1-7:12', '--series=6']);

    const withoutTimes = plannedResult(buildScheduledTaskFlowPlan([
      { ...taskFlow[0], id: 'fight-2', params: { stages: [{ stage: '1-7' }], series: 6 } }
    ]));
    assert.deepEqual(withoutTimes.steps[0].args, ['1-7', '--series=6']);

    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute(taskFlow, 'flow-single-series'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series=6']
    ]);

    calls.commands.length = 0;
    await completedResult(await executor.execute([
      { ...taskFlow[0], id: 'fight-3', params: { stages: [{ stage: '1-7', times: 12 }], series: '1' } }
    ], 'flow-single-default-series'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12']
    ]);
  });

  it('keeps the selected series for every stage in a multi-stage fight', async () => {
    const taskFlow = [
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: {
          stages: [{ stage: '1-7', times: 12 }, { stage: 'CE-6', times: 12 }],
          series: 6
        }
      }
    ];

    const plan = plannedResult(buildScheduledTaskFlowPlan(taskFlow));
    assert.deepEqual(plan.steps[0].args, ['1-7:12,CE-6:12', '--series=6']);

    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute(taskFlow, 'flow-multi-series'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series=6'],
      ['CE-6', '--times', '12', '--series=6']
    ]);
  });

  it('keeps series=-1 as a single clap token when times are set', async () => {
    const singleStageFlow = [
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: '1-7', times: 12 }], series: '-1' }
      }
    ];

    const plan = plannedResult(buildScheduledTaskFlowPlan(singleStageFlow));
    assert.deepEqual(plan.steps[0].args, ['1-7:12', '--series=-1']);

    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute(singleStageFlow, 'flow-single-series-disabled'));
    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series=-1']
    ]);

    calls.commands.length = 0;
    await completedResult(await executor.execute([
      {
        ...singleStageFlow[0],
        id: 'fight-2',
        params: { stages: [{ stage: '1-7', times: 12 }, { stage: 'CE-6', times: 12 }], series: '-1' }
      }
    ], 'flow-multi-series-disabled'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series=-1'],
      ['CE-6', '--times', '12', '--series=-1']
    ]);
  });
});
