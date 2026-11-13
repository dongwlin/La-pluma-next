import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AgentRunDto } from '../services/agentRunService.ts';
import type { MaaLogCheckpoint, MaaLogIncrement } from '../services/maaLogFileService.ts';
import {
  ROGUELIKE_STOP_INTENT_MAX_WAIT_MS,
  beginRoguelikeStopIntent,
  cancelRoguelikeStopIntent,
  configureRoguelikeStopIntentRuntimeForTests,
  getRoguelikeStopIntent,
  resetRoguelikeStopIntentForTests
} from '../services/roguelikeStopIntentService.ts';
import type { RoguelikeStopIntentRuntime } from '../services/roguelikeStopIntentService.ts';
import { enrichAgentRun } from '../services/runSnapshotService.ts';
import type { AgentRunProgressProjection } from '../services/runSnapshotService.ts';
import { loggerManager } from '../utils/logger.ts';

loggerManager.getLogger('RoguelikeStopIntent').enableConsole = false;

const RUN_START_MS = new Date(2026, 10, 13, 12, 0, 0, 0).getTime();
const NOW_MS = new Date(2026, 10, 13, 12, 3, 0, 0).getTime();

interface TimerEntry {
  callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

interface HarnessOptions {
  run?: AgentRunDto;
  current?: AgentRunDto | null;
  input?: unknown;
  log?: string;
  increment?: MaaLogIncrement;
  checkpoint?: MaaLogCheckpoint | null;
  processRunning?: boolean;
  tailThrows?: boolean;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatLogTime(timeMs: number): string {
  const date = new Date(timeMs);
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}]`;
}

function callbackLine(timeMs: number, taskchain: string, type: string, payload: Record<string, unknown> = {}): string {
  return `${formatLogTime(timeMs)}[INF] Assistant::append_callback | ${type} ${JSON.stringify({
    taskchain,
    ...payload
  })}`;
}

function extraLine(timeMs: number, taskchain: string, what: string): string {
  return callbackLine(timeMs, taskchain, 'SubTaskExtraInfo', { what, details: {} });
}

function makeRun(overrides: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'running',
    acceptedAt: new Date(RUN_START_MS - 5_000).toISOString(),
    startedAt: new Date(RUN_START_MS).toISOString(),
    finishedAt: null,
    result: null,
    links: {
      self: '/api/agent/runs/run-1',
      stop: '/api/agent/actions/stop?runId=run-1'
    },
    ...overrides
  };
}

function createHarness(options: HarnessOptions = {}) {
  const run = options.run ?? makeRun();
  const state = {
    run,
    current: options.current === undefined ? run : options.current,
    log: options.log ?? '',
    increment: options.increment ?? { status: 'ok', text: '' },
    checkpoint: options.checkpoint === undefined
      ? { logPath: '/tmp/maa-logs/asst.log', size: 0 }
      : options.checkpoint,
    processRunning: options.processRunning ?? true,
    nowMs: NOW_MS,
    stopCalls: 0,
    runStopCalls: 0,
    throwOnGetRun: false,
    throwOnGetCurrentRun: false
  };
  const timers: TimerEntry[] = [];

  const runtime: RoguelikeStopIntentRuntime = {
    scheduler: {
      now: () => state.nowMs,
      schedule(callback) {
        const entry: TimerEntry = { callback, cancelled: false, fired: false };
        timers.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      }
    },
    maxWaitMs: ROGUELIKE_STOP_INTENT_MAX_WAIT_MS,
    pollIntervalMs: 1_000,
    createCheckpoint: async () => state.checkpoint,
    readLogTail: async () => {
      if (options.tailThrows) throw new Error('tail read failed');
      return { status: 'ok', text: state.log } satisfies MaaLogIncrement;
    },
    readLogIncrement: async () => state.increment,
    getRun: () => {
      if (state.throwOnGetRun) throw new Error('run lookup failed');
      return state.run;
    },
    getRunInput: () => options.input ?? { command: 'roguelike', args: ['Mizuki'] },
    getCurrentRun: () => {
      if (state.throwOnGetCurrentRun) throw new Error('current run lookup failed');
      return state.current;
    },
    isDeviceTaskRunning: () => state.processRunning,
    stopDeviceTask: () => {
      state.stopCalls += 1;
      return { success: true };
    },
    requestRunStop: () => {
      state.runStopCalls += 1;
      return null;
    }
  };
  configureRoguelikeStopIntentRuntimeForTests(runtime);

  return {
    state,
    timers,
    pendingTimers: () => timers.filter(timer => !timer.cancelled && !timer.fired),
    advance(ms: number) {
      state.nowMs += ms;
    },
    async fire(): Promise<void> {
      const timer = timers.find(candidate => !candidate.cancelled && !candidate.fired);
      assert.ok(timer, 'expected a scheduled poll timer');
      timer.fired = true;
      timer.callback();
      await flushAsyncWork();
    }
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function readProgressStopIntent(run: AgentRunDto): AgentRunProgressProjection['stopIntent'] | null {
  const progress = enrichAgentRun(run)?.progress;
  if (!progress || !('stopIntent' in progress)) return null;
  return progress.stopIntent ?? null;
}

afterEach(() => {
  resetRoguelikeStopIntentForTests();
});

describe('roguelike stop intent', () => {
  it('defers while the latest in-run callback reports combat', async () => {
    const log = [
      extraLine(RUN_START_MS - 60_000, 'Roguelike', 'StageInfo'),
      extraLine(RUN_START_MS + 30_000, 'Roguelike', 'StageInfo')
    ].join('\n');
    const harness = createHarness({ log });

    const outcome = await beginRoguelikeStopIntent('run-1');

    assert.equal(outcome.status, 'deferred');
    assert.deepEqual(outcome.intent, {
      mode: 'after-combat',
      requestedAt: new Date(NOW_MS).toISOString(),
      deadline: new Date(NOW_MS + ROGUELIKE_STOP_INTENT_MAX_WAIT_MS).toISOString(),
      combat: true
    });
    assert.deepEqual(getRoguelikeStopIntent('run-1'), outcome.intent);
    assert.equal(harness.pendingTimers().length, 1);
    assert.equal(harness.state.stopCalls, 0);
  });

  it('ignores combat callbacks written before the run started', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS - 1_000, 'Roguelike', 'StageInfo')
    });

    const outcome = await beginRoguelikeStopIntent('run-1');

    assert.equal(outcome.status, 'immediate');
    assert.equal(getRoguelikeStopIntent('run-1'), null);
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('does not defer when no combat callback is visible for this run', async () => {
    const harness = createHarness({ log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'RoguelikeSettlement') });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.equal(getRoguelikeStopIntent('run-1'), null);
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('does not defer when the latest in-run callback closed the combat', async () => {
    const log = [
      extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      extraLine(RUN_START_MS + 20_000, 'Roguelike', 'RoguelikeCombatEnd')
    ].join('\n');
    const harness = createHarness({ log });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('keeps the combat state when StageInfoError follows StageInfo', async () => {
    const log = [
      extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      extraLine(RUN_START_MS + 2_000, 'Roguelike', 'StageInfoError')
    ].join('\n');
    const harness = createHarness({ log });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'deferred');
    assert.equal(harness.pendingTimers().length, 1);
  });

  it('treats a lone StageInfoError as an unknown combat state', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfoError')
    });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('falls back for runs that are not roguelike or reclamation', async () => {
    const harness = createHarness({
      input: { command: 'startup' },
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('resolves the dynamic task config type as the target', async () => {
    const harness = createHarness({
      input: { command: 'run', taskConfig: { name: '萨卡兹肉鸽', type: 'Roguelike', params: { theme: 'Sarkaz' } } },
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'deferred');
    assert.equal(harness.pendingTimers().length, 1);
  });

  it('uses the Reclamation taskchain for reclamation runs', async () => {
    createHarness({
      input: { command: 'reclamation', args: ['Tales'] },
      log: [
        extraLine(RUN_START_MS - 60_000, 'Roguelike', 'StageInfo'),
        extraLine(RUN_START_MS + 1_000, 'Reclamation', 'StageInfo')
      ].join('\n')
    });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'deferred');
  });

  it('falls back to an immediate stop when the log cannot be read', async () => {
    createHarness({ checkpoint: null });
    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');

    resetRoguelikeStopIntentForTests();
    createHarness({
      tailThrows: true,
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.equal(getRoguelikeStopIntent('run-1'), null);
  });

  it('falls back when the run is no longer the current execution', async () => {
    const otherRun = makeRun({ runId: 'run-2' });
    const harness = createHarness({
      current: otherRun,
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });

    assert.equal((await beginRoguelikeStopIntent('run-1')).status, 'immediate');
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('returns the same intent for a repeated request without adding another poll', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });

    const first = await beginRoguelikeStopIntent('run-1');
    const second = await beginRoguelikeStopIntent('run-1');

    assert.equal(first.status, 'deferred');
    assert.equal(second.status, 'already-pending');
    assert.deepEqual(second.intent, first.intent);
    assert.equal(harness.pendingTimers().length, 1);
    assert.equal(harness.state.stopCalls, 0);
  });

  it('dispatches the stop after the increment reports RoguelikeCombatEnd', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      increment: {
        status: 'ok',
        text: extraLine(NOW_MS + 5_000, 'Roguelike', 'RoguelikeCombatEnd')
      }
    });
    await beginRoguelikeStopIntent('run-1');

    await harness.fire();

    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.runStopCalls, 1);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('does not stop when one increment ends a combat and starts the next', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      increment: {
        status: 'ok',
        text: [
          extraLine(NOW_MS + 1_000, 'Roguelike', 'RoguelikeCombatEnd'),
          extraLine(NOW_MS + 2_000, 'Roguelike', 'StageInfo')
        ].join('\n')
      }
    });
    await beginRoguelikeStopIntent('run-1');

    await harness.fire();

    assert.equal(harness.state.stopCalls, 0);
    assert.equal(getRoguelikeStopIntent('run-1')?.mode, 'after-combat');
    assert.equal(harness.pendingTimers().length, 1);

    harness.state.increment = {
      status: 'ok',
      text: extraLine(NOW_MS + 3_000, 'Roguelike', 'RoguelikeCombatEnd')
    };
    await harness.fire();

    assert.equal(harness.state.stopCalls, 1);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
  });

  it('dispatches on a truncated increment that still carries RoguelikeCombatEnd', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      increment: {
        status: 'truncated',
        text: extraLine(NOW_MS + 5_000, 'Roguelike', 'RoguelikeCombatEnd')
      }
    });
    await beginRoguelikeStopIntent('run-1');

    await harness.fire();

    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.runStopCalls, 1);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
  });

  it('keeps waiting when the increment is unreadable', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      increment: { status: 'unreadable', text: '' }
    });
    await beginRoguelikeStopIntent('run-1');

    await harness.fire();

    assert.equal(harness.state.stopCalls, 0);
    assert.equal(getRoguelikeStopIntent('run-1')?.mode, 'after-combat');
    assert.equal(harness.pendingTimers().length, 1);
  });

  it('keeps waiting when an increment only reports StageInfoError', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo'),
      increment: {
        status: 'ok',
        text: extraLine(NOW_MS + 5_000, 'Roguelike', 'StageInfoError')
      }
    });
    await beginRoguelikeStopIntent('run-1');

    await harness.fire();

    assert.equal(harness.state.stopCalls, 0);
    assert.equal(harness.pendingTimers().length, 1);
  });

  it('releases and stops when a run lookup throws during polling', async () => {
    for (const target of ['getRun', 'getCurrentRun'] as const) {
      resetRoguelikeStopIntentForTests();
      const harness = createHarness({
        log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
      });
      await beginRoguelikeStopIntent('run-1');
      if (target === 'getRun') {
        harness.state.throwOnGetRun = true;
      } else {
        harness.state.throwOnGetCurrentRun = true;
      }

      await harness.fire();

      assert.equal(harness.state.stopCalls, 1, target);
      assert.equal(harness.state.runStopCalls, 1, target);
      assert.equal(getRoguelikeStopIntent('run-1'), null, target);
    }
  });

  it('forces the stop when the wait deadline is reached', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    await beginRoguelikeStopIntent('run-1');

    harness.advance(ROGUELIKE_STOP_INTENT_MAX_WAIT_MS - 1);
    await harness.fire();
    assert.equal(harness.state.stopCalls, 0);

    harness.advance(1);
    await harness.fire();
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.runStopCalls, 1);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
  });

  it('releases the watcher without a stop when the run reaches a terminal state', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    await beginRoguelikeStopIntent('run-1');
    harness.state.run = makeRun({ state: 'succeeded', finishedAt: new Date().toISOString() });
    harness.state.current = null;

    await harness.fire();

    assert.equal(harness.state.stopCalls, 0);
    assert.equal(harness.state.runStopCalls, 0);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
    assert.deepEqual(harness.pendingTimers(), []);
  });

  it('releases the watcher without a stop when the device task already exited', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    await beginRoguelikeStopIntent('run-1');
    harness.state.processRunning = false;

    await harness.fire();

    assert.equal(harness.state.stopCalls, 0);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
  });

  it('exposes progress.stopIntent only while the run is still running', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    const outcome = await beginRoguelikeStopIntent('run-1');
    assert.equal(outcome.status, 'deferred');

    const runningProgress = enrichAgentRun(harness.state.run)?.progress;
    assert.ok(runningProgress);
    assert.equal(runningProgress.message, '等待战斗结束后终止');
    assert.deepEqual(readProgressStopIntent(harness.state.run), outcome.intent);

    assert.equal(readProgressStopIntent({ ...harness.state.run, state: 'stopping' }), null);
    assert.equal(readProgressStopIntent({ ...harness.state.run, state: 'succeeded' }), null);

    cancelRoguelikeStopIntent('run-1');
    assert.equal(readProgressStopIntent(harness.state.run), null);
  });

  it('cancels the pending intent without dispatching a stop', async () => {
    const harness = createHarness({
      log: extraLine(RUN_START_MS + 1_000, 'Roguelike', 'StageInfo')
    });
    await beginRoguelikeStopIntent('run-1');

    assert.equal(cancelRoguelikeStopIntent('run-1'), true);
    assert.equal(cancelRoguelikeStopIntent('run-1'), false);
    assert.equal(getRoguelikeStopIntent('run-1'), null);
    assert.deepEqual(harness.pendingTimers(), []);
    assert.equal(harness.state.stopCalls, 0);
  });
});
