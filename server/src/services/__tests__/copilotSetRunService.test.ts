import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  beginAgentRun,
  getAgentRun,
  markAgentRunStopping,
  resetAgentRunsForTests,
  startAgentRunForExecution
} from '../agentRunService.ts';
import type { AgentRunDto } from '../agentRunService.ts';
import {
  configureCopilotSetRuntimeForTests,
  continueManualCopilotSet,
  getCopilotSetRunProgress,
  hasCopilotSetSession,
  requestCopilotSetRunStop,
  resetCopilotSetRunStateForTests,
  runContinuousCopilotSet,
  startManualCopilotSet
} from '../copilotSetRunService.ts';
import type {
  CopilotSetManualOutcome,
  CopilotSetProgress,
  CopilotSetRunResult,
  CopilotSetStoppedOutcome,
  CopilotSetStopOutcome,
  CopilotSetWaitingOutcome
} from '../copilotSetRunService.ts';
import type {
  CopilotEntriesOutcome,
  CopilotEntryOutcomeStatus,
  CopilotExecutionLifecycle,
  CopilotPlan,
  CopilotPlanEntry,
  CopilotTaskResult
} from '../copilotPlanService.ts';
import type { ExecuteCopilotEntriesInput } from '../copilotPlanService.ts';
import { getMaaExecutionLeaseSnapshot, withMaaExecutionLease } from '../executionCoordinatorService.ts';

let lockDir: string;
let lockFile: string;
let previousLockFile: string | undefined;

before(async () => {
  lockDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-set-'));
  lockFile = join(lockDir, 'maa-execution.lock');
  previousLockFile = process.env.LA_PLUMA_MAA_LOCK_FILE;
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockFile;
});

after(async () => {
  if (previousLockFile === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE;
  else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLockFile;
  await rm(lockDir, { recursive: true, force: true });
});

interface ErrorFields {
  code?: string;
  stopped?: boolean;
}

function errorFields(error: unknown): ErrorFields {
  return error as ErrorFields;
}

function runOf(runId: string): AgentRunDto {
  const run = getAgentRun(runId);
  assert.ok(run, `expected run ${runId} to exist`);
  return run;
}

function storedResult(runId: string): CopilotSetRunResult {
  return runOf(runId).result as CopilotSetRunResult;
}

function progressOf(runId: string): CopilotSetProgress {
  const progress = getCopilotSetRunProgress(runId);
  assert.ok(progress, `expected copilot set progress for ${runId}`);
  return progress;
}

function waitingOutcome(outcome: CopilotSetManualOutcome): CopilotSetWaitingOutcome {
  assert.ok('waitingForNext' in outcome, 'expected a waiting manual outcome');
  return outcome;
}

function isStoppedOutcome(outcome: CopilotSetManualOutcome): outcome is CopilotSetStoppedOutcome {
  return 'stopped' in outcome;
}

function stopOutcomeOf(runId: string): CopilotSetStopOutcome {
  const outcome = requestCopilotSetRunStop(runId);
  assert.ok(outcome, `expected a copilot set stop outcome for ${runId}`);
  return outcome;
}

function planFor(count = 2): CopilotPlan {
  return {
    setId: '42',
    name: '测试作业集',
    items: [],
    entries: Array.from({ length: count }, (_, index) => ({
      key: `${index}:${100 + index}:normal`,
      itemIndex: index,
      copilotId: 100 + index,
      stageId: `main_01-0${index + 1}`,
      displayStage: `1-${index + 1}`,
      apCost: 6,
      mode: 'normal',
      presetFormation: false,
      completed: false
    }))
  };
}

interface EntryExecutor {
  executed: string[];
  execute(input: ExecuteCopilotEntriesInput): Promise<CopilotEntriesOutcome>;
}

/**
 * Simulates the copilot entry executor while keeping the real execution lease
 * and lifecycle gates, so the service's waiting/stop orchestration is real.
 */
function createEntryExecutor({
  failures = new Set<string>(),
  onExecute = () => {},
  onAfterSuccess = null
}: {
  failures?: ReadonlySet<string>;
  onExecute?: (entry: CopilotPlanEntry) => void | Promise<void>;
  onAfterSuccess?: ((entry: CopilotPlanEntry) => void | Promise<void>) | null;
} = {}): EntryExecutor {
  const executed: string[] = [];
  return {
    executed,
    execute: async ({ entries = [], lifecycle = {} }: ExecuteCopilotEntriesInput): Promise<CopilotEntriesOutcome> => {
      const statusByKey = new Map<string, CopilotEntryOutcomeStatus>(
        entries.map(entry => [entry.key, 'pending'])
      );
      let stopped = false;
      await withMaaExecutionLease({ source: 'copilot-set', taskName: '测试作业集', command: 'copilot-plan' }, async () => {
        await lifecycle.onBeforeStart?.();
        lifecycle.onStarted?.();
        for (const entry of entries) {
          if (await lifecycle.shouldStop?.()) {
            stopped = true;
            break;
          }
          lifecycle.onEntryStarted?.(entry, [entry]);
          executed.push(entry.key);
          await onExecute(entry);
          const failed = failures.has(entry.key);
          statusByKey.set(entry.key, failed ? 'failed' : 'success');
          lifecycle.onEntrySettled?.(entry, failed ? 'failed' : 'success', failed ? '模拟失败' : undefined);
          await onAfterSuccess?.(entry);
        }
      });
      const taskResults: CopilotTaskResult[] = entries.map(entry => {
        const status = statusByKey.get(entry.key) ?? 'pending';
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
          status,
          ...(status === 'failed' ? { error: '模拟失败' } : {})
        };
      });
      const count = (status: CopilotEntryOutcomeStatus) =>
        taskResults.filter(result => result.status === status).length;
      return {
        success: count('failed') === 0,
        stopped,
        error: null,
        results: [],
        completed: taskResults.filter(result => result.status === 'success').map(result => result.key),
        pending: entries.filter(entry => statusByKey.get(entry.key) !== 'success'),
        loopTimes: 1,
        summary: {
          totalEntries: taskResults.length,
          successCount: count('success'),
          failedCount: count('failed'),
          stoppedCount: count('stopped'),
          pendingCount: count('pending'),
          taskResults
        }
      };
    }
  };
}

function useRuntime({ plan = planFor(), executor }: { plan?: CopilotPlan; executor: EntryExecutor }): void {
  configureCopilotSetRuntimeForTests({
    buildCopilotPlan: async () => plan,
    executeCopilotEntries: executor.execute
  });
}

/** 整组成功的执行汇总：模拟真实执行端在命令正常退出时的逐项结算。 */
function allSuccessOutcome(entries: readonly CopilotPlanEntry[]): CopilotEntriesOutcome {
  const taskResults: CopilotTaskResult[] = entries.map(entry => ({
    key: entry.key,
    itemIndex: entry.itemIndex,
    copilotId: entry.copilotId,
    stageId: entry.stageId,
    stage: entry.displayStage,
    displayStage: entry.displayStage,
    apCost: entry.apCost,
    mode: entry.mode,
    presetFormation: Boolean(entry.presetFormation),
    status: 'success'
  }));
  return {
    success: true,
    stopped: false,
    error: null,
    results: [],
    completed: taskResults.map(result => result.key),
    pending: [],
    loopTimes: 1,
    summary: {
      totalEntries: taskResults.length,
      successCount: taskResults.length,
      failedCount: 0,
      stoppedCount: 0,
      pendingCount: 0,
      taskResults
    }
  };
}

function beginSetRun(): AgentRunDto {
  return beginAgentRun({ operationId: 'run_copilot_set', input: { setId: '42' } }).run;
}

function lifecycleFor(runId: string): CopilotExecutionLifecycle {
  return {
    onBeforeStart: () => {
      startAgentRunForExecution(runId);
    }
  };
}

async function holdLease(): Promise<void> {
  await writeFile(lockFile, JSON.stringify({
    pid: process.pid,
    source: 'other-client',
    taskName: '其他执行',
    command: 'run',
    startedAt: new Date().toISOString()
  }));
}

describe('copilot set runs', () => {
  beforeEach(async () => {
    resetAgentRunsForTests();
    resetCopilotSetRunStateForTests();
    await rm(lockFile, { force: true });
  });

  afterEach(async () => {
    resetCopilotSetRunStateForTests();
    resetAgentRunsForTests();
    await rm(lockFile, { force: true });
  });

  it('runs a continuous set as one attempt with per-entry results', async () => {
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ executor });

    const result = await runContinuousCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal']);
    assert.equal(result.finished, true);
    assert.equal(result.stopped, false);
    assert.equal(result.summary.successCount, 2);
    assert.deepEqual(
      result.summary.taskResults.map(item => [item.key, item.status]),
      [['0:100:normal', 'success'], ['1:101:normal', 'success']]
    );
    assert.equal(hasCopilotSetSession(run.runId), false);
  });

  it('holds no lease while a manual set waits and resumes on the next entry', async () => {
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ executor });

    const started = waitingOutcome(await startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    }));

    assert.equal(started.waitingForNext, true);
    assert.equal(started.nextEntry?.key, '1:101:normal');
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null });
    assert.equal(progressOf(run.runId).phase, 'waiting_for_next');
    assert.equal(progressOf(run.runId).pendingCount, 1);

    await holdLease();
    await assert.rejects(
      () => continueManualCopilotSet({ runId: run.runId }),
      error => errorFields(error).code === 'MAA_EXECUTION_BUSY'
    );
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.equal(progressOf(run.runId).pendingCount, 1);
    assert.deepEqual(executor.executed, ['0:100:normal']);

    await rm(lockFile, { force: true });
    const finished = await continueManualCopilotSet({ runId: run.runId });

    assert.equal(finished.finished, true);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal']);
    assert.equal(storedResult(run.runId).summary.successCount, 2);
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null });
  });

  it('discards the manual session when the first entry cannot acquire the lease', async () => {
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ executor });
    await holdLease();

    await assert.rejects(
      () => startManualCopilotSet({
        runId: run.runId,
        setId: '42',
        raid: 'normal',
        selectedIndexes: [],
        options: {},
        lifecycle: lifecycleFor(run.runId)
      }),
      error => errorFields(error).code === 'MAA_EXECUTION_BUSY'
    );

    assert.equal(hasCopilotSetSession(run.runId), false);
    assert.equal(runOf(run.runId).state, 'accepted');
    assert.deepEqual(executor.executed, []);
  });

  it('returns to waiting after each manual entry until the queue is done', async () => {
    const plan = planFor(3);
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ plan, executor });

    const first = waitingOutcome(await startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    }));
    assert.equal(first.waitingForNext, true);

    const second = waitingOutcome(await continueManualCopilotSet({ runId: run.runId }));
    assert.equal(second.waitingForNext, true);
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.equal(progressOf(run.runId).pendingCount, 1);
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal']);

    const third = await continueManualCopilotSet({ runId: run.runId });
    assert.equal(third.finished, true);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal', '2:102:normal']);
  });

  it('stops a waiting manual set without starting the next entry', async () => {
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ executor });

    await startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    const stopped = stopOutcomeOf(run.runId);
    const stopResult = stopped.run.result as CopilotSetRunResult;
    assert.equal(stopped.disposition, 'stopped');
    assert.equal(stopped.run.state, 'stopped');
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.summary.successCount, 1);
    assert.equal(stopResult.summary.pendingCount, 1);
    assert.equal(hasCopilotSetSession(run.runId), false);

    await assert.rejects(
      () => continueManualCopilotSet({ runId: run.runId }),
      error => errorFields(error).code === 'AGENT_COPILOT_SET_SESSION_LOST'
    );
    assert.deepEqual(executor.executed, ['0:100:normal']);
    assert.equal(runOf(run.runId).state, 'stopped');
  });

  it('records an entry failure but keeps the manual set waiting for the rest', async () => {
    const plan = planFor(2);
    const run = beginSetRun();
    const executor = createEntryExecutor({ failures: new Set([plan.entries[0].key]) });
    useRuntime({ plan, executor });

    const started = waitingOutcome(await startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    }));

    assert.equal(started.waitingForNext, true);
    assert.equal(started.result.summary.failedCount, 1);
    assert.equal(started.result.summary.pendingCount, 1);
    assert.equal(runOf(run.runId).state, 'waiting');

    const finished = await continueManualCopilotSet({ runId: run.runId });

    assert.equal(finished.finished, true);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.equal(storedResult(run.runId).summary.failedCount, 1);
    assert.equal(storedResult(run.runId).summary.successCount, 1);
    assert.equal(
      storedResult(run.runId).summary.taskResults[0].status,
      'failed'
    );
  });

  it('rejects a concurrent next request while an entry is still running', async () => {
    const plan = planFor(2);
    const run = beginSetRun();
    const firstEntryGate = { release: null as (() => void) | null };
    const gatePromise = new Promise<void>(resolve => {
      firstEntryGate.release = resolve;
    });
    let firstAttempt = true;
    const executor = createEntryExecutor({
      onExecute: async () => {
        if (!firstAttempt) return;
        firstAttempt = false;
        await gatePromise;
      }
    });
    useRuntime({ plan, executor });

    const startPromise = startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && runOf(run.runId).state !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(runOf(run.runId).state, 'running');

    await assert.rejects(
      () => continueManualCopilotSet({ runId: run.runId }),
      error => errorFields(error).code === 'AGENT_COPILOT_SET_NOT_WAITING'
    );

    firstEntryGate.release?.();
    const started = waitingOutcome(await startPromise);
    assert.equal(started.waitingForNext, true);
    assert.deepEqual(executor.executed, ['0:100:normal']);
    assert.equal(progressOf(run.runId).nextEntry?.key, '1:101:normal');
  });

  it('turns an in-flight manual entry into stopped when the set is stopped', async () => {
    const run = beginSetRun();
    const executor = createEntryExecutor({
      onExecute: () => {
        markAgentRunStopping(run.runId);
        const error = Object.assign(new Error('任务已终止'), { stopped: true });
        throw error;
      }
    });
    useRuntime({ executor });

    const outcome = await startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    assert.ok(isStoppedOutcome(outcome));
    assert.equal(outcome.stopped, true);
    assert.equal(runOf(run.runId).state, 'stopped');
    assert.equal(storedResult(run.runId).summary.stoppedCount, 1);
    assert.equal(storedResult(run.runId).summary.pendingCount, 1);
    assert.equal(hasCopilotSetSession(run.runId), false);
  });

  it('does not run the next entry after a stop lands between entries', async () => {
    const plan = planFor(3);
    const run = beginSetRun();
    let stopRequested = false;
    const executor = createEntryExecutor({
      onAfterSuccess: () => {
        if (stopRequested) return;
        stopRequested = true;
        markAgentRunStopping(run.runId);
      }
    });
    useRuntime({ plan, executor });

    const result = await runContinuousCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    assert.deepEqual(executor.executed, ['0:100:normal']);
    assert.equal(result.stopped, true);
    assert.equal(result.summary.successCount, 1);
    assert.equal(result.summary.pendingCount, 2);
    assert.equal(hasCopilotSetSession(run.runId), false);
  });

  it('projects currentStep as the one-based position of the running or next entry', async () => {
    const plan = planFor(3);
    const run = beginSetRun();
    const gates: Array<() => void> = [];
    let heldCount = 0;
    const executor = createEntryExecutor({
      onExecute: async () => {
        if (heldCount >= 2) return;
        heldCount += 1;
        await new Promise<void>(resolve => {
          gates.push(resolve);
        });
      }
    });
    useRuntime({ plan, executor });

    const started = startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && gates.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 1, 'first entry should start');
    // 第一项执行中：currentStep 是它在待执行队列中的 1 基序号。
    assert.equal(progressOf(run.runId).currentStep, 1);
    assert.equal(progressOf(run.runId).totalSteps, 3);
    gates[0]?.();

    const first = waitingOutcome(await started);
    assert.equal(first.waitingForNext, true);
    // 等待下一关时 currentStep 已指向下一个待执行条目。
    assert.equal(progressOf(run.runId).currentStep, 2);
    assert.equal(progressOf(run.runId).nextEntry?.key, plan.entries[1].key);

    const second = continueManualCopilotSet({ runId: run.runId });
    while (Date.now() < deadline && gates.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 2, 'second entry should start');
    assert.equal(progressOf(run.runId).currentStep, 2);
    gates[1]?.();

    await second;
    assert.equal(progressOf(run.runId).currentStep, 3);

    const finished = await continueManualCopilotSet({ runId: run.runId });
    assert.equal(finished.finished, true);
    assert.equal(storedResult(run.runId).summary.successCount, 3);
    assert.equal(storedResult(run.runId).summary.skippedCount, 0);
  });

  it('projects unselected unfinished entries as skipped', async () => {
    const plan = planFor(3);
    const run = beginSetRun();
    const gates: Array<() => void> = [];
    const gate = new Promise<void>(resolve => {
      gates.push(resolve);
    });
    const executor = createEntryExecutor({ onExecute: () => gate });
    useRuntime({ plan, executor });

    const started = startManualCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [plan.entries[1].itemIndex],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && runOf(run.runId).state !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const progress = progressOf(run.runId);
    // 队列里只有被选中的第二条目；未选中的未完成条目按 skipped 追加投影。
    assert.equal(progress.totalSteps, 1);
    assert.equal(progress.skippedCount, 2);
    assert.equal(progress.currentStep, 1);
    assert.deepEqual(progress.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[1].key, 'running'],
      [plan.entries[0].key, 'skipped'],
      [plan.entries[2].key, 'skipped']
    ]);
    gates[0]?.();

    const startedOutcome = await started;
    assert.equal(startedOutcome.finished, true);
    // 汇总条目覆盖本次队列与本次跳过；本次尝试数与计划总数各自独立表达。
    assert.equal(startedOutcome.result.summary.plannedEntries, 3);
    assert.equal(startedOutcome.result.summary.queuedEntries, 1);
    assert.equal(startedOutcome.result.summary.totalEntries, 3);
    assert.equal(startedOutcome.result.summary.skippedCount, 2);
    assert.deepEqual(storedResult(run.runId).summary.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[1].key, 'success'],
      [plan.entries[0].key, 'skipped'],
      [plan.entries[2].key, 'skipped']
    ]);
  });

  it('does not mark previously completed entries as skipped', async () => {
    const plan = planFor(3);
    plan.entries[0].completed = true;
    const run = beginSetRun();
    const executor = createEntryExecutor();
    useRuntime({ plan, executor });

    const result = await runContinuousCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [plan.entries[0].itemIndex, plan.entries[2].itemIndex],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });

    assert.deepEqual(executor.executed, [plan.entries[2].key]);
    assert.equal(result.summary.alreadyCompletedCount, 1);
    assert.equal(result.summary.skippedCount, 1);
    assert.equal(result.summary.plannedEntries, 3);
    assert.equal(result.summary.queuedEntries, 1);
    assert.equal(result.summary.totalEntries, 2);
    assert.equal(result.summary.totalEntries, result.summary.taskResults.length);
    assert.deepEqual(result.summary.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[2].key, 'success'],
      [plan.entries[1].key, 'skipped']
    ]);
  });

  it('keeps only the truly executing entry as running while a group advances', async () => {
    const plan = planFor(3);
    const run = beginSetRun();
    const gates: Array<() => void> = [];
    const waitForGate = (): Promise<void> => new Promise<void>(resolve => {
      gates.push(resolve);
    });
    const executor: EntryExecutor = {
      executed: [],
      execute: async ({ entries = [], lifecycle = {} }: ExecuteCopilotEntriesInput): Promise<CopilotEntriesOutcome> => {
        const group = [...entries];
        await withMaaExecutionLease({ source: 'copilot-set', taskName: '测试作业集', command: 'copilot-plan' }, async () => {
          await lifecycle.onBeforeStart?.();
          lifecycle.onStarted?.();
          for (const [index, entry] of group.entries()) {
            if (index > 0) {
              // 模拟文件加载观察的推进方式：上一条目随下一份计划文件结算成功。
              lifecycle.onEntrySettled?.(group[index - 1], 'success');
              lifecycle.onEntryStarted?.(entry, [entry]);
            } else {
              lifecycle.onEntryStarted?.(entry, [entry]);
            }
            executor.executed.push(entry.key);
            await waitForGate();
          }
          lifecycle.onEntrySettled?.(group[group.length - 1], 'success');
        });
        return allSuccessOutcome(group);
      }
    };
    useRuntime({ plan, executor });

    const runPromise = runContinuousCopilotSet({
      runId: run.runId,
      setId: '42',
      raid: 'normal',
      selectedIndexes: [],
      options: {},
      lifecycle: lifecycleFor(run.runId)
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && gates.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 1, 'first entry should start');
    let progress = progressOf(run.runId);
    assert.deepEqual(progress.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[0].key, 'running'],
      [plan.entries[1].key, 'pending'],
      [plan.entries[2].key, 'pending']
    ]);
    assert.equal(progress.currentStep, 1);
    gates[0]?.();

    while (Date.now() < deadline && gates.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 2, 'second entry should start');
    progress = progressOf(run.runId);
    assert.deepEqual(progress.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[0].key, 'success'],
      [plan.entries[1].key, 'running'],
      [plan.entries[2].key, 'pending']
    ]);
    assert.equal(progress.currentStep, 2);
    assert.equal(progress.successCount, 1);
    gates[1]?.();

    while (Date.now() < deadline && gates.length < 3) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 3, 'third entry should start');
    progress = progressOf(run.runId);
    assert.equal(progress.currentStep, 3);
    gates[2]?.();

    const result = await runPromise;
    assert.equal(result.finished, true);
    assert.equal(result.summary.successCount, 3);
    // 组结束时的统一结算与会话内已推进的逐项状态一致，重复结算幂等。
    assert.deepEqual(result.summary.taskResults.map(item => [item.key, item.status]), [
      [plan.entries[0].key, 'success'],
      [plan.entries[1].key, 'success'],
      [plan.entries[2].key, 'success']
    ]);
  });
});
