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
import {
  buildFlowExecutionOutcome,
  getFightReportResults,
  parseFightStatistics,
  parseTaskSummary
} from '../scheduleFlowResult.ts';
import type { TaskCompletionInfo } from '../notificationService.ts';
import type { DropRecordInput } from '../dropRecordService.ts';
import type { MaaExecutionLeaseRequest } from '../executionCoordinatorService.ts';
import { parseGameTaskExecutionAction } from '../gameTaskResultService.ts';
import type { GameTaskType } from '../gameTaskResultService.ts';

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
    dynamicTasks: [] as Array<{ taskId: string; taskConfig: string; taskName: string | null; clientType?: string }>,
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
    executeDynamicTask: async (taskId, taskConfig, taskName, _taskType, _waitForCompletion, clientType) => {
      calls.dynamicTasks.push({ taskId, taskConfig, taskName, clientType });
      return { stdout: '', stderr: '' };
    },
    createLogCheckpoint: async () => {
      calls.checkpoints += 1;
      return { logPath: 'asst.log', size: 0 };
    },
    readLogSince: async () => {
      calls.reads += 1;
      return { status: 'ok', text: 'log-1' };
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
    parseDepotData: async () => ({ success: true, data: { itemCount: 0 } }),
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
  it('counts observed game outcomes and leaves absent callbacks explicitly unconfirmed', async () => {
    const { ports } = createPorts({
      executeDynamicTask: async (_taskId, taskConfig, taskName) => {
        const config = JSON.parse(taskConfig) as { type: GameTaskType; params: { themes?: string[] } };
        const name = taskName || '';
        const log = name === '培养成功'
          ? 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","what":"OperProgressSummary","details":{"success":1,"failed":0,"skipped":0}}'
          : name === '培养部分失败'
            ? 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","what":"OperProgressSummary","details":{"success":1,"failed":1,"skipped":0}}'
            : name === '主题跳过'
              ? 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"SwitchTheme","what":"SwitchThemeSkipped"}'
              : '';
        const action = parseGameTaskExecutionAction(name, config.type, log);
        if (name === '主题跳过') assert.deepEqual(config.params.themes, []);
        if (action.status === 'failed') throw Object.assign(new Error(action.message), { details: { actions: [action] } });
        return { stdout: '', stderr: '', actions: [action] };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const tasks = [
      { name: '培养成功', taskType: 'OperProgress', params: { plans: [{ name: '阿米娅', elite: 2 }] } },
      { name: '培养部分失败', taskType: 'OperProgress', params: { plans: [{ name: '阿米娅', elite: 2 }] } },
      { name: '主题跳过', taskType: 'SwitchTheme', params: { themes: [] } },
      { name: '主题结果未知', taskType: 'SwitchTheme', params: { themes: ['默认'] } }
    ].map((task, index) => ({ ...task, id: `game-${index}`, enabled: true }));
    const result = completedResult(await executor.execute(tasks, 'game-flow'));
    assert.deepEqual([result.summary.successCount, result.summary.failedCount, result.summary.skippedCount], [2, 1, 1]);
    assert.deepEqual(result.summary.taskResults.map(task => task.status), ['success', 'failed', 'skipped', 'success']);
    assert.deepEqual(result.summary.actions.map(action => action.status), ['success', 'failed', 'skipped', 'success']);
    assert.match(result.summary.warnings[0], /游戏结果未确认/);
    assert.equal(result.summary.errors.length, 1);
  });


  it('runs the startup launch switch as a Core StartUp task with the task client type', async () => {
    const { ports, calls } = createPorts();
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const result = completedResult(await executor.execute([{
      id: 'startup-1',
      commandId: 'startup',
      name: '启动游戏',
      enabled: true,
      params: {
        clientType: 'Bilibili',
        accountName: '4567',
        start_game_enabled: false
      }
    }], 'startup-flow'));

    assert.equal(result.summary.successCount, 1);
    assert.equal(calls.dynamicTasks.length, 1);
    assert.equal(calls.dynamicTasks[0].taskId, 'startup');
    assert.equal(calls.dynamicTasks[0].clientType, 'Bilibili');
    assert.deepEqual(JSON.parse(calls.dynamicTasks[0].taskConfig), {
      name: '启动游戏',
      type: 'StartUp',
      params: {
        start_game_enabled: false,
        account_name: '4567',
        client_type: 'Bilibili'
      }
    });
    assert.match(result.summary.actions[0].message, /已进入游戏主界面/);
  });

  it('normalizes a blank startup client type and falls back to the connection profile', async () => {
    const checkedClientTypes: string[] = [];
    const { ports, calls } = createPorts({
      resolveConnection: async () => ({
        adbPath: 'adb',
        address: '127.0.0.1:5555',
        clientType: 'YoStarJP'
      }),
      getGameClientState: async (_adbPath, _address, clientType) => {
        checkedClientTypes.push(clientType);
        return { running: true, foregroundPackage: 'com.hypergryph.arknights' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    await completedResult(await executor.execute([{
      id: 'startup-blank',
      commandId: 'startup',
      name: '启动游戏',
      enabled: true,
      params: { clientType: '', start_game_enabled: false }
    }], 'startup-blank-client'));

    assert.equal(calls.dynamicTasks.length, 1);
    assert.equal(calls.dynamicTasks[0].clientType, undefined);
    assert.deepEqual(checkedClientTypes, ['YoStarJP']);

    calls.dynamicTasks.length = 0;
    checkedClientTypes.length = 0;
    await completedResult(await executor.execute([{
      id: 'startup-explicit',
      commandId: 'startup',
      name: '启动游戏',
      enabled: true,
      params: { clientType: 'Bilibili', start_game_enabled: false }
    }], 'startup-explicit-client'));

    assert.equal(calls.dynamicTasks[0].clientType, 'Bilibili');
    assert.deepEqual(checkedClientTypes, ['Bilibili']);
  });

  it('rejects invalid game task plans while retaining generic dynamic tasks', () => {
    const makeTask = (taskType: string, params: Record<string, unknown>) => [{
      id: 'dynamic-1', name: '动态任务', enabled: true, taskType, params
    }];
    assert.equal(validateScheduledTaskFlow(makeTask('OperProgress', { plans: [{ name: '陈', skill_level: 8 }] })).success, false);
    assert.equal(validateScheduledTaskFlow(makeTask('SwitchTheme', { themes: '默认' })).success, false);
    assert.equal(validateScheduledTaskFlow(makeTask('FutureCoreTask', { arbitrary: { nested: true } })).success, true);
    assert.deepEqual(plannedResult(buildScheduledTaskFlowPlan(makeTask('SwitchTheme', { themes: [] }))).steps[0].taskConfig, {
      name: '动态任务', type: 'SwitchTheme', params: { themes: [] }
    });
  });

  it('migrates legacy roguelike params when planning and validating saved flows', () => {
    const legacyFlow = [{
      id: 'roguelike-1',
      name: '刷常乐节点',
      enabled: true,
      taskType: 'Roguelike',
      params: { theme: 'JieGarden', mode: 20001, find_play_time_target: 2 }
    }];

    assert.equal(validateScheduledTaskFlow(legacyFlow).success, true);
    const step = plannedResult(buildScheduledTaskFlowPlan(legacyFlow)).steps[0];
    assert.ok(step);
    assert.deepEqual(step.taskConfig, {
      name: '刷常乐节点',
      type: 'Roguelike',
      params: { theme: 'JieGarden', mode: 20001, find_playTime_target: 2 }
    });

    const conflictFlow = [{
      id: 'roguelike-2',
      name: '刷常乐节点',
      enabled: true,
      taskType: 'Roguelike',
      params: {
        theme: 'JieGarden',
        mode: 20001,
        find_play_time_target: 1,
        find_playTime_target: 2
      }
    }];
    assert.deepEqual(validateScheduledTaskFlow(conflictFlow), {
      success: false,
      message: 'Roguelike.params 同时包含 find_play_time_target 与 find_playTime_target 且取值不同'
    });
  });

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

  it('counts unconfirmed award results as failed instead of skipped', async () => {
    const { ports, calls } = createPorts({ readLogSince: async () => ({ status: 'unreadable', text: '' }) });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    const result = completedResult(await executor.execute([
      { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: { award: true } }
    ], 'flow-award-unconfirmed'));

    assert.equal(calls.commands.length, 1);
    assert.equal(result.summary.failedCount, 1);
    assert.equal(result.summary.skippedCount, 0);
    assert.equal(result.summary.successCount, 0);
    assert.deepEqual(result.summary.taskResults.map(task => task.status), ['failed']);
    assert.equal(result.summary.errors.length, 1);
    assert.match(result.summary.errors[0].error, /无法读取领取日志/);
    assert.equal(result.summary.actions[0].status, 'failed');
  });

  it('counts a partially confirmed award task as failed rather than success', async () => {
    const callback = (payload: Record<string, unknown>): string =>
      `Assistant::append_callback | SubTaskCompleted ${JSON.stringify({
        taskchain: 'Award',
        ...payload
      })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'ok',
        text: callback({ first: ['AwardBegin'], details: { task: 'ReceiveAward' } })
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });

    const result = completedResult(await executor.execute([
      {
        id: 'award-1',
        commandId: 'award',
        name: '领取奖励',
        enabled: true,
        params: { award: true, mail: true, orundum: true }
      }
    ], 'flow-award-partial'));

    assert.equal(calls.commands.length, 1);
    assert.deepEqual(
      result.summary.actions.map(action => action.status),
      ['success', 'failed', 'failed']
    );
    assert.equal(result.summary.failedCount, 1);
    assert.equal(result.summary.successCount, 0);
    assert.equal(result.summary.skippedCount, 0);
    assert.deepEqual(result.summary.taskResults.map(task => task.status), ['failed']);
    assert.equal(result.summary.errors.length, 2);
    assert.match(result.summary.errors[0].error, /邮件奖励未观察到领取回调/);
    assert.match(result.summary.errors[1].error, /合成玉活动奖励未观察到领取回调/);
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

  it('keeps the imported depot count when the flow is stopped during the post-depot delay', async () => {
    const parsed = deferred<{ success: true; data: { itemCount: number } }>();
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
    parsed.resolve({ success: true, data: { itemCount: 86 } });

    const result = completedResult(await execution);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.summary.actions, [{
      task: '关闭游戏',
      action: 'depot',
      status: 'success',
      message: '关闭前仓库识别完成，共 86 项'
    }]);
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

  it('parses structured fight callbacks into incremental battles, sanity and drops', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 6, series: 1 }),
      callback('SanityBeforeStage', { current_sanity: 30, max_sanity: 135 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemName: '源岩', quantity: 2 }],
        stats: [{ itemName: '源岩', quantity: 2, addQuantity: 2 }]
      }),
      callback('FightTimes', { times_finished: 1, sanity_cost: 6, series: 1 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemName: '固源岩', quantity: 1 }],
        stats: [
          { itemName: '源岩', quantity: 2, addQuantity: 0 },
          { itemName: '固源岩', quantity: 1, addQuantity: 1 }
        ]
      }),
      callback('FightTimes', { times_finished: 2, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.stage, '1-7');
    assert.equal(statistics.battles, 2);
    assert.equal(statistics.sanity, 12);
    assert.equal(statistics.sanityBeforeStage, 30);
    assert.equal(statistics.maxSanity, 135);
    assert.deepEqual(statistics.drops, [{ name: '源岩', count: 2 }, { name: '固源岩', count: 1 }]);
    assert.deepEqual(statistics.cumulativeDrops, [{ name: '源岩', count: 2 }, { name: '固源岩', count: 1 }]);
    assert.deepEqual(statistics.observed, { stageDrops: true, fightTimes: true, sanityBeforeStage: true });
  });

  it('keeps the item ids the core callback reports for drops', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 6, series: 1 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemId: '30012', itemName: '固源岩', quantity: 2 }],
        stats: [{ itemId: '30012', itemName: '固源岩', quantity: 2, addQuantity: 2 }]
      }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemId: '30012', itemName: '固源岩', quantity: 1 }],
        stats: [{ itemId: '30012', itemName: '固源岩', quantity: 3, addQuantity: 1 }]
      }),
      callback('FightTimes', { times_finished: 2, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.deepEqual(statistics.drops, [{ itemId: '30012', name: '固源岩', count: 3 }]);
    assert.deepEqual(statistics.cumulativeDrops, [{ itemId: '30012', name: '固源岩', count: 3 }]);
  });

  it('counts a six-run series batch as six battles with the batch sanity cost', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 36, series: 6 }),
      callback('SanityBeforeStage', { current_sanity: 90, max_sanity: 135 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 6,
        drops: [
          { itemName: '源岩', quantity: 12 },
          { itemName: '固源岩', quantity: 3 }
        ],
        stats: [
          { itemName: '源岩', quantity: 12, addQuantity: 12 },
          { itemName: '固源岩', quantity: 3, addQuantity: 3 }
        ]
      }),
      callback('FightTimes', { times_finished: 6, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.stage, '1-7');
    assert.equal(statistics.battles, 6);
    assert.equal(statistics.sanity, 36);
    assert.deepEqual(statistics.drops, [{ name: '源岩', count: 12 }, { name: '固源岩', count: 3 }]);
    assert.deepEqual(statistics.observed, { stageDrops: true, fightTimes: true, sanityBeforeStage: true });
  });

  it('sums mixed series batches by actual battle count and per-batch sanity', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 36, series: 6 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 6,
        drops: [{ itemName: '源岩', quantity: 12 }],
        stats: [{ itemName: '源岩', quantity: 12, addQuantity: 12 }]
      }),
      callback('FightTimes', { times_finished: 6, sanity_cost: 12, series: 2 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 2,
        drops: [{ itemName: '源岩', quantity: 4 }],
        stats: [{ itemName: '源岩', quantity: 16, addQuantity: 4 }]
      }),
      callback('FightTimes', { times_finished: 8, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.battles, 8);
    assert.equal(statistics.sanity, 48);
    assert.deepEqual(statistics.drops, [{ name: '源岩', count: 16 }]);
  });

  it('keeps the batch sanity when a battle screen is not recognized', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 36, series: 6 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 6,
        drops: [{ itemName: '源岩', quantity: 12 }],
        stats: [{ itemName: '源岩', quantity: 12, addQuantity: 12 }]
      }),
      callback('FightTimes', { times_finished: 6, sanity_cost: 36, series: 6 }),
      callback('FightTimes', { times_finished: 12, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.battles, 12);
    assert.equal(statistics.sanity, 72);
  });

  it('leaves sanity unknown when a fought batch has no confirmed sanity cost', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemName: '源岩', quantity: 2 }],
        stats: [{ itemName: '源岩', quantity: 2, addQuantity: 2 }]
      }),
      callback('FightTimes', { times_finished: 1, finished: true })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.battles, 1);
    assert.equal(statistics.sanity, undefined);
  });

  it('keeps only cumulative evidence when the log increment is truncated', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 6, sanity_cost: 12, series: 2 }),
      callback('SanityBeforeStage', { current_sanity: 30, max_sanity: 135 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 2,
        drops: [{ itemName: '固源岩', quantity: 2 }],
        stats: [
          { itemName: '源岩', quantity: 10, addQuantity: 2 },
          { itemName: '固源岩', quantity: 6, addQuantity: 2 }
        ]
      })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7', { logComplete: false });
    assert.ok(statistics);
    assert.equal(statistics.battles, 6);
    assert.equal(statistics.sanity, undefined);
    assert.equal(statistics.sanityBeforeStage, undefined);
    assert.equal(statistics.maxSanity, undefined);
    assert.deepEqual(statistics.drops, [{ name: '源岩', count: 10 }, { name: '固源岩', count: 6 }]);
    assert.deepEqual(statistics.cumulativeDrops, [{ name: '源岩', count: 10 }, { name: '固源岩', count: 6 }]);
    assert.deepEqual(statistics.observed, { stageDrops: true, fightTimes: true, sanityBeforeStage: true });
  });

  it('leaves drops empty rather than summing tail-only increments when cumulative stats are missing', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 1, sanity_cost: 6, series: 1 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        drops: [{ itemName: '固源岩', quantity: 2 }]
      })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7', { logComplete: false });
    assert.ok(statistics);
    assert.equal(statistics.battles, 1);
    assert.deepEqual(statistics.drops, []);
    assert.equal(statistics.sanity, undefined);
  });

  it('does not count batches that never fought toward the sanity total', () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const log = [
      callback('FightTimes', { times_finished: 0, sanity_cost: 36, series: 6 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 6,
        drops: [],
        stats: []
      }),
      callback('FightTimes', { times_finished: 6, sanity_cost: 36, series: 6 }),
      callback('StageDrops', {
        stage: { stageCode: '1-7' },
        stars: 3,
        cur_times: 6,
        drops: [],
        stats: []
      }),
      callback('FightTimes', { times_finished: 12, sanity_cost: 36, series: 6 })
    ].join('\n');

    const statistics = parseFightStatistics(log, '1-7');
    assert.ok(statistics);
    assert.equal(statistics.battles, 12);
    assert.equal(statistics.sanity, 72);
  });

  it('records zero-drop stages and uses the observed sanity cost', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'ok',
        text: [
          callback('FightTimes', { times_finished: 1, sanity_cost: 21 }),
          callback('SanityBeforeStage', { current_sanity: 50, max_sanity: 135 }),
          callback('StageDrops', {
            stage: { stageCode: 'CE-6' },
            stars: 3,
            drops: [],
            stats: []
          })
        ].join('\n')
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: 'CE-6', times: 1 }
      }
    ], 'flow-zero-drop'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].stage, 'CE-6');
    assert.equal(calls.drops[0].times, 1);
    assert.equal(calls.drops[0].sanity, 21);
    assert.deepEqual(calls.drops[0].items, []);
    assert.equal(calls.drops[0].sanityBefore, 50);
    assert.equal(calls.drops[0].maxSanity, 135);
    assert.match(calls.drops[0].recordKey || '', /^flow-zero-drop:\d+:fight-1:CE-6:0$/);
  });

  it('falls back to the fight summary when structured callbacks are missing', async () => {
    const { ports, calls } = createPorts({
      readLogSince: async () => ({ status: 'ok', text: 'no structured fight callbacks' }),
      executeCommand: async (command, args, taskName) => {
        calls.commands.push({ command, args, taskName });
        return { stdout: 'Fight 1-7 3 times, total drops: 龙门币 × 252', stderr: '' };
      }
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 3 }
      }
    ], 'flow-summary-fallback'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].stage, '1-7');
    assert.equal(calls.drops[0].times, 3);
    assert.equal(calls.drops[0].sanity, undefined);
    assert.deepEqual(calls.drops[0].items, [{ name: '龙门币', count: 252 }]);
    assert.equal(calls.drops[0].medicine, 0);
    assert.equal(calls.drops[0].stone, 0);
    assert.match(calls.drops[0].recordKey || '', /^flow-summary-fallback:\d+:fight-1:1-7:0$/);
  });

  it('persists the actual battle count and batch sanity for a six-run series', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'ok',
        text: [
          callback('FightTimes', { times_finished: 0, sanity_cost: 36, series: 6 }),
          callback('SanityBeforeStage', { current_sanity: 90, max_sanity: 135 }),
          callback('StageDrops', {
            stage: { stageCode: '1-7' },
            stars: 3,
            cur_times: 6,
            drops: [{ itemName: '源岩', quantity: 12 }],
            stats: [{ itemName: '源岩', quantity: 12, addQuantity: 12 }]
          }),
          callback('FightTimes', { times_finished: 6, finished: true })
        ].join('\n')
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 6, series: 6 }
      }
    ], 'flow-series-six'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].stage, '1-7');
    assert.equal(calls.drops[0].times, 6);
    assert.equal(calls.drops[0].sanity, 36);
    assert.deepEqual(calls.drops[0].items, [{ name: '源岩', count: 12 }]);
    assert.equal(calls.drops[0].sanityBefore, 90);
    assert.equal(calls.drops[0].maxSanity, 135);
  });

  it('omits sanity from the drop record when no cost is confirmed', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'ok',
        text: [
          callback('FightTimes', { times_finished: 0 }),
          callback('StageDrops', {
            stage: { stageCode: '1-7' },
            stars: 3,
            drops: [{ itemName: '源岩', quantity: 2 }],
            stats: [{ itemName: '源岩', quantity: 2, addQuantity: 2 }]
          }),
          callback('FightTimes', { times_finished: 1, finished: true })
        ].join('\n')
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 1 }
      }
    ], 'flow-sanity-unknown'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].times, 1);
    assert.equal(calls.drops[0].sanity, undefined);
    assert.deepEqual(calls.drops[0].items, [{ name: '源岩', count: 2 }]);
  });

  it('warns instead of silently skipping fight results without drop information', async () => {
    const warnings: Array<{ message: string; data?: unknown }> = [];
    const { ports, calls } = createPorts({
      readLogSince: async () => ({ status: 'unreadable', text: '' }),
      executeCommand: async () => ({ stdout: '', stderr: '' })
    });
    const executor = createScheduleFlowExecutor({
      ports,
      logger: {
        ...silentLogger,
        warn: (message: string, data?: unknown) => {
          warnings.push({ message, data });
        }
      }
    });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: 'CE-6', times: 1 }
      }
    ], 'flow-no-drop-info'));

    assert.equal(calls.drops.length, 0);
    assert.ok(warnings.some(warning => /掉落/.test(warning.message)
      && (warning.data as { scheduleId?: string }).scheduleId === 'flow-no-drop-info'
      && (warning.data as { stage?: string }).stage === 'CE-6'));
  });

  it('keeps structured fight statistics ahead of the stdout summary', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'ok',
        text: [
          callback('FightTimes', { times_finished: 1, sanity_cost: 21 }),
          callback('StageDrops', {
            stage: { stageCode: 'CE-6' },
            stars: 3,
            drops: [],
            stats: []
          })
        ].join('\n')
      }),
      executeCommand: async () => ({ stdout: 'Fight 1-7 3 times, total drops: 龙门币 × 252', stderr: '' })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 3 }
      }
    ], 'flow-structured-priority'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].stage, 'CE-6');
    assert.equal(calls.drops[0].times, 1);
    assert.equal(calls.drops[0].sanity, 21);
    assert.deepEqual(calls.drops[0].items, []);
  });

  it('prefers the complete CLI summary when the fight log increment is truncated', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'truncated',
        text: [
          callback('FightTimes', { times_finished: 6, sanity_cost: 12, series: 2 }),
          callback('SanityBeforeStage', { current_sanity: 30, max_sanity: 135 }),
          callback('StageDrops', {
            stage: { stageCode: '1-7' },
            stars: 3,
            cur_times: 2,
            drops: [{ itemName: '固源岩', quantity: 2 }],
            stats: [{ itemName: '源岩', quantity: 10, addQuantity: 2 }]
          })
        ].join('\n')
      }),
      executeCommand: async () => ({
        stdout: 'Fight 1-7 8 times, total drops: 源岩 × 16, 固源岩 × 6',
        stderr: ''
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    const result = completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stage: '1-7', times: 8 }
      }
    ], 'flow-truncated-log'));

    assert.equal(calls.drops.length, 1);
    assert.equal(calls.drops[0].stage, '1-7');
    assert.equal(calls.drops[0].times, 8);
    assert.equal(calls.drops[0].sanity, undefined);
    assert.deepEqual(calls.drops[0].items, [{ name: '源岩', count: 16 }, { name: '固源岩', count: 6 }]);
    assert.match(calls.drops[0].recordKey || '', /^flow-truncated-log:\d+:fight-1:1-7:0$/);

    const fightAction = result.summary.actions.find(action => action.action === 'fight');
    assert.ok(fightAction);
    assert.equal(fightAction.times, 8);
    assert.equal(fightAction.drops, '源岩 × 16, 固源岩 × 6');
  });

  it('applies the truncated-log summary preference to every stage in a multi-stage fight', async () => {
    const callback = (what: string, details: Record<string, unknown>) =>
      `Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({ taskchain: 'Fight', what, details })}`;
    const { ports, calls } = createPorts({
      readLogSince: async () => ({
        status: 'truncated',
        text: [
          callback('FightTimes', { times_finished: 6, sanity_cost: 12, series: 2 }),
          callback('SanityBeforeStage', { current_sanity: 30, max_sanity: 135 })
        ].join('\n')
      }),
      executeCommand: async (_command, args) => ({
        stdout: `Fight ${args[0]} 8 times, total drops: 源岩 × 16`,
        stderr: ''
      })
    });
    const executor = createScheduleFlowExecutor({ ports, logger: silentLogger });
    await completedResult(await executor.execute([
      {
        id: 'fight-1',
        commandId: 'fight',
        name: '理智作战',
        enabled: true,
        params: { stages: [{ stage: '1-7', times: 8 }, { stage: 'CE-6', times: 8 }] }
      }
    ], 'flow-truncated-multi'));

    assert.equal(calls.drops.length, 2);
    assert.deepEqual(calls.drops.map(drop => drop.stage), ['1-7', 'CE-6']);
    assert.deepEqual(calls.drops.map(drop => drop.times), [8, 8]);
    assert.deepEqual(calls.drops.map(drop => drop.sanity), [undefined, undefined]);
    assert.deepEqual(calls.drops.map(drop => drop.items), [
      [{ name: '源岩', count: 16 }],
      [{ name: '源岩', count: 16 }]
    ]);
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
