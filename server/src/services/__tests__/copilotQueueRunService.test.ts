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
  configureCopilotQueueRuntimeForTests,
  continueManualCopilotQueue,
  getCopilotQueueRunProgress,
  hasCopilotQueueSession,
  requestCopilotQueueRunStop,
  requestCopilotQueueSkip,
  resetCopilotQueueRunStateForTests,
  runContinuousCopilotQueue,
  startManualCopilotQueue
} from '../copilotQueueRunService.ts';
import type {
  CopilotQueueLifecycle,
  CopilotQueueProgress,
  CopilotQueueRunResult
} from '../copilotQueueRunService.ts';
import type {
  CopilotEntryOutcomeStatus,
  CopilotExecutionLifecycle,
  CopilotQueueEntriesOutcome,
  CopilotQueuePlan,
  CopilotQueuePlanEntry
} from '../copilotPlanService.ts';
import type { ExecuteCopilotQueueEntriesInput } from '../copilotPlanService.ts';
import { getMaaExecutionLeaseSnapshot, withMaaExecutionLease } from '../executionCoordinatorService.ts';

let lockDir: string;
let lockFile: string;
let previousLockFile: string | undefined;

before(async () => {
  lockDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-queue-'));
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
  details?: Record<string, unknown>;
}

function errorFields(error: unknown): ErrorFields {
  return error as ErrorFields;
}

function summaryOf(error: unknown): Record<string, unknown> {
  const details = errorFields(error).details;
  const summary = details?.summary;
  assert.ok(typeof summary === 'object' && summary !== null);
  return summary as Record<string, unknown>;
}

function runOf(runId: string): AgentRunDto {
  const run = getAgentRun(runId);
  assert.ok(run, `expected run ${runId} to exist`);
  return run;
}

function storedResult(runId: string): CopilotQueueRunResult {
  return runOf(runId).result as CopilotQueueRunResult;
}

function progressOf(runId: string): CopilotQueueProgress {
  const progress = getCopilotQueueRunProgress(runId);
  assert.ok(progress, `expected copilot queue progress for ${runId}`);
  return progress;
}

function planFor(count = 2): CopilotQueuePlan {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      key: `queue-${index}`,
      clientId: `queue-${index}`,
      source: 'prts' as const,
      itemIndex: index,
      copilotId: 100 + index,
      stageId: `main_01-0${index + 1}`,
      displayStage: `1-${index + 1}`,
      apCost: 6,
      mode: 'normal' as const,
      presetFormation: false
    }))
  };
}

interface QueueExecutor {
  executed: string[];
  inputs: ExecuteCopilotQueueEntriesInput[];
  execute(input: ExecuteCopilotQueueEntriesInput): Promise<CopilotQueueEntriesOutcome>;
}

/**
 * Simulates queue entry execution while keeping the real execution lease and
 * lifecycle gates, so waiting/stop orchestration in the service stays real.
 */
function createQueueExecutor({
  failures = new Set<string>(),
  onExecute = () => {},
  onAfterSuccess = null
}: {
  failures?: ReadonlySet<string>;
  onExecute?: (entry: CopilotQueuePlanEntry) => void | Promise<void>;
  onAfterSuccess?: ((entry: CopilotQueuePlanEntry) => void | Promise<void>) | null;
} = {}): QueueExecutor {
  const executed: string[] = [];
  const inputs: ExecuteCopilotQueueEntriesInput[] = [];
  return {
    executed,
    inputs,
    execute: async (input: ExecuteCopilotQueueEntriesInput): Promise<CopilotQueueEntriesOutcome> => {
      inputs.push(input);
      const entries = input.entries ?? [];
      const lifecycle = input.lifecycle ?? {};
      const statuses = new Map<string, CopilotEntryOutcomeStatus>(
        entries.map(entry => [entry.key, 'pending'])
      );
      let stopped = false;
      await withMaaExecutionLease({
        source: 'copilot-queue',
        taskName: '测试作业队列',
        command: 'copilot-queue'
      }, async () => {
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
          statuses.set(entry.key, failed ? 'failed' : 'success');
          lifecycle.onEntrySettled?.(entry, failed ? 'failed' : 'success', failed ? '模拟失败' : undefined);
          await onAfterSuccess?.(entry);
        }
      });
      return {
        stopped,
        error: null,
        completed: [...statuses].filter(([, status]) => status === 'success').map(([key]) => key),
        loopTimes: 1,
        statuses: entries.map(entry => ({
          entry,
          status: statuses.get(entry.key) || 'pending',
          ...(statuses.get(entry.key) === 'failed' ? { error: '模拟失败' } : {})
        }))
      };
    }
  };
}

function useRuntime({
  plan = planFor(),
  executor
}: {
  plan?: CopilotQueuePlan;
  executor: QueueExecutor;
}): void {
  configureCopilotQueueRuntimeForTests({
    buildCopilotQueuePlan: async () => plan,
    executeCopilotQueueEntries: executor.execute
  });
}

function beginQueueRun(): AgentRunDto {
  return beginAgentRun({ operationId: 'run_copilot_queue', input: { queueId: 'q' } }).run;
}

function lifecycleFor(runId: string): CopilotExecutionLifecycle {
  return {
    onBeforeStart: () => {
      startAgentRunForExecution(runId);
    }
  };
}

function queueRunInput(run: AgentRunDto, lifecycle: CopilotQueueLifecycle = {}): Parameters<typeof runContinuousCopilotQueue>[0] {
  return {
    runId: run.runId,
    queueId: 'q',
    name: '测试作业队列',
    entries: [],
    mode: 'continuous',
    failurePolicy: 'stop',
    options: {},
    lifecycle
  };
}

function manualRunInput(run: AgentRunDto, lifecycle: CopilotQueueLifecycle = {}): Parameters<typeof startManualCopilotQueue>[0] {
  return { ...queueRunInput(run, lifecycle), mode: 'manual' };
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

function taskResultStatuses(result: CopilotQueueRunResult): [string, string][] {
  return result.summary.taskResults.map(item => [item.clientId, item.status]);
}

describe('copilot queue runs', () => {
  beforeEach(async () => {
    resetAgentRunsForTests();
    resetCopilotQueueRunStateForTests();
    await rm(lockFile, { force: true });
  });

  afterEach(async () => {
    resetCopilotQueueRunStateForTests();
    resetAgentRunsForTests();
    await rm(lockFile, { force: true });
  });

  it('runs a continuous queue entry by entry with per-entry results', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ executor });

    const result = await runContinuousCopilotQueue(queueRunInput(run, {
      ...lifecycleFor(run.runId),
      shouldStop: () => false
    }));

    assert.deepEqual(executor.executed, ['queue-0', 'queue-1']);
    assert.deepEqual(executor.inputs[0]?.entries?.map(entry => entry.clientId), ['queue-0', 'queue-1']);
    assert.equal(result.finished, true);
    assert.equal(result.stopped, false);
    assert.equal(result.queueId, 'q');
    assert.equal(result.mode, 'continuous');
    assert.equal(result.failurePolicy, 'stop');
    assert.equal(result.summary.totalEntries, 2);
    assert.equal(result.summary.successCount, 2);
    assert.equal(result.summary.failedCount, 0);
    assert.deepEqual(taskResultStatuses(result), [['queue-0', 'success'], ['queue-1', 'success']]);
    assert.equal(hasCopilotQueueSession(run.runId), false);
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null });
  });

  it('records entry failures in the terminal summary without failing the run attempt', async () => {
    const plan = planFor(2);
    const run = beginQueueRun();
    const executor = createQueueExecutor({ failures: new Set([plan.entries[0].key]) });
    useRuntime({ plan, executor });

    const result = await runContinuousCopilotQueue({
      ...queueRunInput(run),
      failurePolicy: 'continue',
      lifecycle: lifecycleFor(run.runId)
    });

    assert.equal(result.finished, true);
    assert.equal(result.stopped, false);
    assert.equal(result.message, '作业队列执行完成，1 项失败');
    assert.equal(result.summary.failedCount, 1);
    assert.equal(result.summary.successCount, 1);
    assert.deepEqual(result.summary.errors, [{
      clientId: 'queue-0',
      stage: '1-1',
      error: '模拟失败'
    }]);
    assert.deepEqual(executor.executed, ['queue-0', 'queue-1']);
    assert.equal(executor.inputs[0]?.failurePolicy, 'continue');
    assert.equal(hasCopilotQueueSession(run.runId), false);
  });

  it('fails the queue attempt when the executor reports an infrastructure error', async () => {
    const run = beginQueueRun();
    useRuntime({
      executor: {
        executed: [],
        inputs: [],
        execute: async () => ({
          stopped: false,
          error: Object.assign(new Error('掉落记录写入失败'), { code: 'COPILOT_QUEUE_DROPS_FAILED' }),
          statuses: [],
          completed: [],
          loopTimes: 1
        })
      }
    });

    await assert.rejects(
      () => runContinuousCopilotQueue(queueRunInput(run, lifecycleFor(run.runId))),
      error => {
        assert.equal(errorFields(error).code, 'COPILOT_QUEUE_DROPS_FAILED');
        assert.equal(summaryOf(error).failedCount, 0);
        return true;
      }
    );
    assert.equal(hasCopilotQueueSession(run.runId), false);
  });

  it('finishes a manual queue when an entry fails under the stop policy', async () => {
    const plan = planFor(2);
    const run = beginQueueRun();
    const executor = createQueueExecutor({ failures: new Set([plan.entries[0].key]) });
    useRuntime({ plan, executor });

    const outcome = await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));

    assert.equal(outcome.result.finished, true);
    assert.equal(outcome.result.waitingForNext, false);
    assert.equal(outcome.result.summary.failedCount, 1);
    assert.equal(outcome.result.summary.pendingCount, 1);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.deepEqual(executor.executed, ['queue-0']);
    assert.equal(hasCopilotQueueSession(run.runId), false);

    await assert.rejects(
      () => continueManualCopilotQueue({ runId: run.runId }),
      error => errorFields(error).code === 'AGENT_COPILOT_QUEUE_SESSION_LOST'
    );
  });

  it('keeps waiting after a manual entry failure under the continue policy', async () => {
    const plan = planFor(2);
    const run = beginQueueRun();
    const executor = createQueueExecutor({ failures: new Set([plan.entries[0].key]) });
    useRuntime({ plan, executor });

    const outcome = await startManualCopilotQueue({
      ...manualRunInput(run, lifecycleFor(run.runId)),
      failurePolicy: 'continue'
    });

    assert.equal(outcome.result.waitingForNext, true);
    assert.equal(outcome.result.nextEntry?.clientId, 'queue-1');
    assert.equal(outcome.result.summary.failedCount, 1);
    assert.equal(runOf(run.runId).state, 'waiting');

    const finished = await continueManualCopilotQueue({ runId: run.runId });

    assert.equal(finished.result.finished, true);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.equal(storedResult(run.runId).summary.failedCount, 1);
    assert.equal(storedResult(run.runId).summary.successCount, 1);
    assert.deepEqual(executor.executed, ['queue-0', 'queue-1']);
  });

  it('holds no lease while a manual queue waits and resumes on the next entry', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ executor });

    const started = await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));

    assert.equal(started.result.waitingForNext, true);
    assert.equal(started.result.nextEntry?.clientId, 'queue-1');
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null });
    assert.equal(progressOf(run.runId).phase, 'waiting_for_next');
    assert.equal(progressOf(run.runId).nextEntry?.clientId, 'queue-1');
    assert.equal(progressOf(run.runId).pendingCount, 1);
    assert.equal(storedResult(run.runId).summary.successCount, 1);

    await holdLease();
    await assert.rejects(
      () => continueManualCopilotQueue({ runId: run.runId }),
      error => errorFields(error).code === 'MAA_EXECUTION_BUSY'
    );
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.deepEqual(executor.executed, ['queue-0']);

    await rm(lockFile, { force: true });
    const finished = await continueManualCopilotQueue({ runId: run.runId });

    assert.equal(finished.result.finished, true);
    assert.equal(finished.result.stopped, false);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.deepEqual(executor.executed, ['queue-0', 'queue-1']);
    assert.equal(storedResult(run.runId).summary.successCount, 2);
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null });
  });

  it('discards the manual queue session when the first entry cannot acquire the lease', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ executor });
    await holdLease();

    await assert.rejects(
      () => startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId))),
      error => errorFields(error).code === 'MAA_EXECUTION_BUSY'
    );

    assert.equal(hasCopilotQueueSession(run.runId), false);
    assert.equal(runOf(run.runId).state, 'accepted');
    assert.deepEqual(executor.executed, []);
  });

  it('skips the next pending entry while a manual queue waits', async () => {
    const plan = planFor(3);
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ plan, executor });

    await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));
    const skipped = requestCopilotQueueSkip(run.runId);

    assert.equal(skipped.skippedClientId, 'queue-1');
    assert.equal(skipped.waitingForNext, true);
    assert.equal(skipped.finished, false);
    assert.equal(skipped.nextEntry?.clientId, 'queue-2');
    assert.equal(runOf(run.runId).state, 'waiting');
    assert.equal(progressOf(run.runId).skippedCount, 1);
    assert.equal(progressOf(run.runId).nextEntry?.clientId, 'queue-2');

    const finished = await continueManualCopilotQueue({ runId: run.runId });

    assert.equal(finished.result.finished, true);
    assert.deepEqual(executor.executed, ['queue-0', 'queue-2']);
    assert.deepEqual(taskResultStatuses(storedResult(run.runId)), [
      ['queue-0', 'success'],
      ['queue-1', 'skipped'],
      ['queue-2', 'success']
    ]);
    assert.equal(storedResult(run.runId).summary.skippedCount, 1);
  });

  it('finishes a manual queue when the last pending entry is skipped', async () => {
    const plan = planFor(2);
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ plan, executor });

    await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));
    const skipped = requestCopilotQueueSkip(run.runId);

    assert.equal(skipped.skippedClientId, 'queue-1');
    assert.equal(skipped.finished, true);
    assert.equal(runOf(run.runId).state, 'succeeded');
    assert.equal(storedResult(run.runId).summary.skippedCount, 1);
    assert.equal(storedResult(run.runId).summary.successCount, 1);
    assert.equal(hasCopilotQueueSession(run.runId), false);

    await assert.rejects(
      () => continueManualCopilotQueue({ runId: run.runId }),
      error => errorFields(error).code === 'AGENT_COPILOT_QUEUE_SESSION_LOST'
    );
    assert.deepEqual(executor.executed, ['queue-0']);
  });

  it('rejects skipping while a continuous queue is running', async () => {
    const plan = planFor(2);
    const run = beginQueueRun();
    const gate = { release: null as (() => void) | null };
    const held = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    const executor = createQueueExecutor({ onExecute: () => held });
    useRuntime({ plan, executor });

    const runPromise = runContinuousCopilotQueue(queueRunInput(run, lifecycleFor(run.runId)));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && runOf(run.runId).state !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(runOf(run.runId).state, 'running');

    assert.throws(
      () => requestCopilotQueueSkip(run.runId),
      error => errorFields(error).code === 'AGENT_COPILOT_QUEUE_NOT_WAITING'
    );

    gate.release?.();
    const result = await runPromise;
    assert.equal(result.summary.successCount, 2);
  });

  it('stops a waiting manual queue without starting the next entry', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ executor });

    await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));
    const stopped = requestCopilotQueueRunStop(run.runId);

    assert.ok(stopped);
    assert.equal(stopped.disposition, 'stopped');
    assert.equal(stopped.run.state, 'stopped');
    const result = stopped.run.result as CopilotQueueRunResult;
    assert.equal(result.stopped, true);
    assert.equal(result.summary.successCount, 1);
    assert.equal(result.summary.pendingCount, 1);
    assert.equal(hasCopilotQueueSession(run.runId), false);

    await assert.rejects(
      () => continueManualCopilotQueue({ runId: run.runId }),
      error => errorFields(error).code === 'AGENT_COPILOT_QUEUE_SESSION_LOST'
    );
    assert.deepEqual(executor.executed, ['queue-0']);
    assert.equal(runOf(run.runId).state, 'stopped');
  });

  it('does not run the next entry after a stop lands between entries', async () => {
    const plan = planFor(3);
    const run = beginQueueRun();
    let stopRequested = false;
    const executor = createQueueExecutor({
      onAfterSuccess: () => {
        if (stopRequested) return;
        stopRequested = true;
        markAgentRunStopping(run.runId);
      }
    });
    useRuntime({ plan, executor });

    const result = await runContinuousCopilotQueue(queueRunInput(run, lifecycleFor(run.runId)));

    assert.deepEqual(executor.executed, ['queue-0']);
    assert.equal(result.stopped, true);
    assert.equal(result.summary.successCount, 1);
    assert.equal(result.summary.pendingCount, 2);
    assert.equal(hasCopilotQueueSession(run.runId), false);
  });

  it('turns an in-flight manual entry into stopped when the queue is stopped', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor({
      onExecute: () => {
        markAgentRunStopping(run.runId);
        throw Object.assign(new Error('任务已终止'), { stopped: true });
      }
    });
    useRuntime({ executor });

    const outcome = await startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));

    assert.equal(outcome.result.stopped, true);
    assert.equal(runOf(run.runId).state, 'stopped');
    assert.equal(storedResult(run.runId).summary.stoppedCount, 1);
    assert.equal(storedResult(run.runId).summary.pendingCount, 1);
    assert.equal(hasCopilotQueueSession(run.runId), false);
  });

  it('projects the stop intent while an entry is running and stops before the next one', async () => {
    const run = beginQueueRun();
    const gate = { release: null as (() => void) | null };
    const held = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    const executor = createQueueExecutor({ onExecute: () => held });
    useRuntime({ executor });

    const runPromise = runContinuousCopilotQueue(queueRunInput(run, lifecycleFor(run.runId)));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && runOf(run.runId).state !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(progressOf(run.runId).shouldStop, false);

    markAgentRunStopping(run.runId);
    assert.equal(progressOf(run.runId).shouldStop, true);

    gate.release?.();
    const result = await runPromise;

    assert.equal(result.stopped, true);
    assert.deepEqual(executor.executed, ['queue-0']);
    assert.deepEqual(taskResultStatuses(result), [['queue-0', 'success'], ['queue-1', 'pending']]);
  });

  it('projects the running entry as the current step and client', async () => {
    const plan = planFor(3);
    const run = beginQueueRun();
    const gates: Array<() => void> = [];
    const executor = createQueueExecutor({
      onExecute: async () => {
        await new Promise<void>(resolve => {
          gates.push(resolve);
        });
      }
    });
    useRuntime({ plan, executor });
    const deadline = Date.now() + 2000;

    const started = startManualCopilotQueue(manualRunInput(run, lifecycleFor(run.runId)));
    while (Date.now() < deadline && gates.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 1);

    const running = progressOf(run.runId);
    assert.equal(running.phase, 'running');
    assert.equal(running.currentStep, 1);
    assert.equal(running.currentClientId, 'queue-0');
    assert.equal(running.totalSteps, 3);

    gates[0]?.();
    const first = await started;
    assert.equal(first.result.nextEntry?.clientId, 'queue-1');
    const waiting = progressOf(run.runId);
    assert.equal(waiting.phase, 'waiting_for_next');
    assert.equal(waiting.currentStep, 2);
    assert.equal(waiting.pendingCount, 2);

    const second = continueManualCopilotQueue({ runId: run.runId });
    while (Date.now() < deadline && gates.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(gates.length >= 2);
    const secondRunning = progressOf(run.runId);
    assert.equal(secondRunning.phase, 'running');
    assert.equal(secondRunning.currentStep, 2);
    assert.equal(secondRunning.currentClientId, 'queue-1');
    gates[1]?.();
    await second;

    assert.deepEqual(executor.executed, ['queue-0', 'queue-1']);
  });

  it('reports progress as starting before the first entry settles', async () => {
    const run = beginQueueRun();
    const executor = createQueueExecutor();
    useRuntime({ executor });
    configureCopilotQueueRuntimeForTests({
      buildCopilotQueuePlan: async () => planFor(1),
      executeCopilotQueueEntries: async () => {
        const progress = progressOf(run.runId);
        assert.equal(progress.phase, 'starting');
        assert.equal(progress.currentStep, 1);
        assert.equal(progress.currentClientId, 'queue-0');
        throw new Error('计划阶段读取进度');
      }
    });

    await assert.rejects(
      () => runContinuousCopilotQueue(queueRunInput(run, lifecycleFor(run.runId))),
      /计划阶段读取进度/
    );
  });
});
