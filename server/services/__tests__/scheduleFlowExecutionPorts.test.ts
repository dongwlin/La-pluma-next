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
    drops: [] as DropRecordInput[],
    refreshes: [] as string[],
    leases: [] as MaaExecutionLeaseRequest[]
  };

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
      return run();
    },
    ...overrides
  };

  return { ports, calls };
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

    assert.equal(calls.refreshes.length, 1);
    assert.equal(calls.refreshes[0], 'flow-ports');
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].totalTasks, 3);
    assert.equal(calls.notifications[0].successTasks, 1);
    assert.equal(calls.notifications[0].failedTasks, 1);
    assert.equal(calls.notifications[0].skippedTasks, 1);

    const status = executor.getStatus();
    assert.equal(status.isRunning, false);
    assert.equal(status.scheduleId, null);
    assert.deepEqual(status.lastResult, result.summary);
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
    assert.deepEqual(plan.steps[0].args, ['1-7:12', '--series', '6']);

    const withoutTimes = plannedResult(buildScheduledTaskFlowPlan([
      { ...taskFlow[0], id: 'fight-2', params: { stages: [{ stage: '1-7' }], series: 6 } }
    ]));
    assert.deepEqual(withoutTimes.steps[0].args, ['1-7', '--series', '6']);

    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute(taskFlow, 'flow-single-series'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series', '6']
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
    assert.deepEqual(plan.steps[0].args, ['1-7:12,CE-6:12', '--series', '6']);

    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute(taskFlow, 'flow-multi-series'));

    assert.deepEqual(calls.commands.map(call => call.args), [
      ['1-7', '--times', '12', '--series', '6'],
      ['CE-6', '--times', '12', '--series', '6']
    ]);
  });
});
