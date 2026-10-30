import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  beginAgentRun,
  completeAgentRun,
  failAgentRun,
  fingerprintAgentRunInput,
  flushAgentRunStore,
  getAgentRun,
  getAgentRunStoreStatus,
  initializeAgentRunStore,
  markAgentRunStopping,
  markAgentRunWaiting,
  releaseAgentRunIdempotency,
  setAgentRunAcceptedResult,
  shutdownAgentRunStoreForTests,
  startAgentRun
} from '../agentRunService.ts';
import type {
  AgentRunDto,
  AgentRunStoreOverrides,
  AgentRunStoreSnapshot
} from '../agentRunService.ts';
import { executeScheduledTaskFromCron } from '../schedulerService.ts';

interface ErrorFields {
  code?: string;
  statusCode?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

function errorFields(error: unknown): ErrorFields {
  return error as ErrorFields;
}

function runOf(runId: string): AgentRunDto {
  const run = getAgentRun(runId);
  assert.ok(run, `expected run ${runId} to exist`);
  return run;
}

const quietLogger = {
  info() {},
  error() {}
};

interface TerminalSnapshotOverrides {
  run?: Record<string, unknown>;
  finishedAtMs?: number | null;
  terminalSequence?: number | null;
}

interface TerminalSnapshotRecord {
  run: Record<string, unknown>;
  sequence: number;
  createdAtMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  terminalSequence: number;
}

describe('agent run persistence', () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'la-pluma-agent-runs-'));
    storePath = join(testDir, 'agent-runs.json');
    await shutdownAgentRunStoreForTests();
  });

  afterEach(async () => {
    try {
      await shutdownAgentRunStoreForTests();
    } catch {
      // A deliberately failing writer leaves the store fail-closed. Rebind it
      // to a healthy temporary path so the singleton cannot leak into a test.
      await initializeAgentRunStore({
        filePath: join(testDir, 'cleanup-agent-runs.json'),
        runtimeLogger: quietLogger
      });
      await shutdownAgentRunStoreForTests();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  async function initialize(overrides: AgentRunStoreOverrides = {}) {
    return initializeAgentRunStore({
      filePath: storePath,
      runtimeLogger: quietLogger,
      ...overrides
    });
  }

  async function reload() {
    await shutdownAgentRunStoreForTests();
    return initialize();
  }

  async function readSnapshot(): Promise<AgentRunStoreSnapshot> {
    return JSON.parse(await readFile(storePath, 'utf8')) as AgentRunStoreSnapshot;
  }

  async function writeTerminalSnapshot(overrides: TerminalSnapshotOverrides = {}) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const record: TerminalSnapshotRecord = {
      run: {
        runId: 'persisted-terminal-run',
        operationId: 'fight',
        idempotencyKey: null,
        inputFingerprint: '',
        input: { stage: '1-7' },
        metadata: {},
        status: 'succeeded',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        result: { ok: true },
        error: null
      },
      sequence: 1,
      createdAtMs: nowMs,
      startedAtMs: nowMs,
      finishedAtMs: nowMs,
      terminalSequence: 1
    };
    if (overrides.run) Object.assign(record.run, overrides.run);
    Object.assign(record, { ...overrides, run: record.run });
    await writeFile(storePath, JSON.stringify({ version: 1, runs: [record] }), 'utf8');
  }

  it('creates a versioned empty store when the file is missing', async () => {
    const restored = await initialize();

    assert.deepEqual(restored, {
      filePath: storePath,
      restoredRuns: 0,
      interruptedRuns: 0,
      prunedRuns: 0
    });
    assert.deepEqual((await readSnapshot()).runs, []);
    assert.equal((await readSnapshot()).version, 1);
    assert.deepEqual(getAgentRunStoreStatus(), {
      enabled: true,
      required: true,
      ready: true,
      dirty: false,
      filePath: storePath,
      error: null
    });
  });

  it('cancels recovery without enabling persistence or writing a late snapshot', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const read = Promise.withResolvers<unknown>();
    let writes = 0;
    const restoring = initialize({
      signal: controller.signal,
      readStore: async () => { entered.resolve(); return read.promise; },
      writeStore: async () => { writes += 1; }
    });
    await entered.promise;
    controller.abort(new Error('cancelled run-store recovery'));
    await assert.rejects(restoring, error => error === controller.signal.reason);
    read.resolve({ version: 1, runs: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
    assert.equal(getAgentRunStoreStatus().ready, false);
    assert.throws(() => beginAgentRun({ operationId: 'fight' }));
  });

  it('restores terminal runs and preserves idempotent replay and conflict detection', async () => {
    await initialize();
    const first = beginAgentRun({
      operationId: 'run_task',
      idempotencyKey: 'persistent:request-1',
      input: { command: 'fight', args: ['1-7'] }
    }).run;
    startAgentRun(first.runId);
    completeAgentRun(first.runId, { stdout: 'completed' });
    await flushAgentRunStore();

    const restored = await reload();
    assert.equal(restored.restoredRuns, 1);
    assert.equal(restored.interruptedRuns, 0);
    assert.equal(runOf(first.runId).state, 'succeeded');
    assert.deepEqual(runOf(first.runId).result, { stdout: 'completed' });

    const replay = beginAgentRun({
      operationId: 'run_task',
      idempotencyKey: 'persistent:request-1',
      input: { args: ['1-7'], command: 'fight' }
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.runId, first.runId);

    assert.throws(
      () => beginAgentRun({
        operationId: 'run_task',
        idempotencyKey: 'persistent:request-1',
        input: { command: 'award' }
      }),
      error => errorFields(error).code === 'AGENT_IDEMPOTENCY_KEY_REUSED'
        && errorFields(error).statusCode === 409
    );
  });

  it('prunes restored terminal runs to the newest 500 without reviving evicted keys', async () => {
    const baseMs = Date.now() - 10_000;
    const records = Array.from({ length: 501 }, (_, index): Record<string, unknown> => {
      const timestampMs = baseMs + index;
      const timestamp = new Date(timestampMs).toISOString();
      const input = { index };
      return {
        run: {
          runId: `terminal-run-${index}`,
          operationId: 'bounded_restore',
          idempotencyKey: `bounded:key:${index}`,
          inputFingerprint: fingerprintAgentRunInput(input),
          input,
          metadata: {},
          status: 'succeeded',
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
          durationMs: 0,
          result: { index },
          error: null
        },
        sequence: index + 1,
        createdAtMs: timestampMs,
        startedAtMs: timestampMs,
        finishedAtMs: timestampMs,
        terminalSequence: index + 1
      };
    });
    await writeFile(storePath, JSON.stringify({ version: 1, runs: records }), 'utf8');

    const firstRestore = await initialize();
    assert.equal(firstRestore.restoredRuns, 500);
    assert.equal(firstRestore.prunedRuns, 1);
    assert.equal(getAgentRun('terminal-run-0'), null);
    assert.equal(runOf('terminal-run-1').state, 'succeeded');

    const persisted = await readSnapshot();
    assert.equal(persisted.runs.length, 500);
    assert.equal(persisted.runs.some(record => record.run.runId === 'terminal-run-0'), false);

    const secondRestore = await reload();
    assert.equal(secondRestore.restoredRuns, 500);
    assert.equal(secondRestore.prunedRuns, 0);
    assert.equal(getAgentRun('terminal-run-0'), null);

    const replacement = beginAgentRun({
      operationId: 'bounded_restore',
      idempotencyKey: 'bounded:key:0',
      input: { index: 0 }
    });
    assert.equal(replacement.replayed, false);
    assert.notEqual(replacement.run.runId, 'terminal-run-0');
  });

  it('coalesces synchronous mutations into one final succeeded snapshot', async () => {
    const writes: AgentRunStoreSnapshot[] = [];
    await initialize({
      writeStore: async (filePath, snapshot) => {
        const copy = JSON.parse(JSON.stringify(snapshot)) as AgentRunStoreSnapshot;
        writes.push(copy);
        await writeFile(filePath, JSON.stringify(copy), 'utf8');
      }
    });
    writes.length = 0;

    const run = beginAgentRun({
      operationId: 'run_task',
      idempotencyKey: 'coalesced:run',
      input: { command: 'fight' }
    }).run;
    startAgentRun(run.runId);
    setAgentRunAcceptedResult(run.runId, { phase: 'accepted-result' });
    completeAgentRun(run.runId, { phase: 'complete' });
    await flushAgentRunStore();

    assert.equal(writes.length, 1);
    const [record] = writes[0].runs;
    assert.equal(record.run.runId, run.runId);
    assert.equal(record.run.status, 'succeeded');
    assert.deepEqual(record.run.result, { phase: 'complete' });
    assert.ok(record.run.startedAt);
    assert.ok(record.run.finishedAt);

    const persisted = await readSnapshot();
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.runs[0].run.status, 'succeeded');
    assert.deepEqual(persisted.runs[0].run.result, { phase: 'complete' });
  });

  it('does not strand a dirty mutation in the writer finalization window', async () => {
    const writes: AgentRunStoreSnapshot[] = [];
    let armTerminalMutation = false;
    let runId: string | null = null;
    await initialize({
      writeStore: async (filePath, snapshot) => {
        const copy = JSON.parse(JSON.stringify(snapshot)) as AgentRunStoreSnapshot;
        writes.push(copy);
        await writeFile(filePath, JSON.stringify(copy), 'utf8');
        if (armTerminalMutation) {
          armTerminalMutation = false;
          Promise.resolve().then(() => queueMicrotask(() => {
            completeAgentRun(runId as string, { phase: 'writer-finalization' });
          }));
        }
      }
    });
    writes.length = 0;

    runId = beginAgentRun({ operationId: 'writer_race' }).run.runId;
    armTerminalMutation = true;
    await flushAgentRunStore();

    assert.equal(getAgentRunStoreStatus().dirty, false);
    assert.equal(runOf(runId).state, 'succeeded');
    assert.equal(writes.length, 2);
    const persisted = await readSnapshot();
    assert.equal(persisted.runs[0].run.status, 'succeeded');
    assert.deepEqual(persisted.runs[0].run.result, { phase: 'writer-finalization' });
  });

  it('marks every restored active state interrupted without restarting it', async () => {
    await initialize();
    const accepted = beginAgentRun({
      operationId: 'accepted_operation',
      idempotencyKey: 'active:accepted'
    }).run;
    const running = beginAgentRun({
      operationId: 'running_operation',
      idempotencyKey: 'active:running'
    }).run;
    startAgentRun(running.runId);
    const stopping = beginAgentRun({
      operationId: 'stopping_operation',
      idempotencyKey: 'active:stopping'
    }).run;
    startAgentRun(stopping.runId);
    markAgentRunStopping(stopping.runId);
    const waiting = beginAgentRun({
      operationId: 'waiting_operation',
      idempotencyKey: 'active:waiting'
    }).run;
    startAgentRun(waiting.runId);
    markAgentRunWaiting(waiting.runId);
    await flushAgentRunStore();

    const restored = await reload();
    assert.equal(restored.interruptedRuns, 4);

    const interruptedStates: Array<[string, string]> = [
      [accepted.runId, 'accepted'],
      [running.runId, 'running'],
      [stopping.runId, 'stopping'],
      [waiting.runId, 'waiting']
    ];
    for (const [runId, previousState] of interruptedStates) {
      const run = runOf(runId);
      assert.equal(run.state, 'interrupted');
      assert.ok(run.error);
      assert.equal(run.error.code, 'AGENT_RUN_INTERRUPTED');
      assert.equal(run.error.statusCode, 503);
      assert.equal(run.error.retryable, false);
      assert.deepEqual(run.error.details, {
        reason: 'server_restart',
        previousState
      });
      assert.ok(run.recovery);
      assert.deepEqual(run.recovery, {
        source: 'server_restart',
        previousState,
        executionResumed: false,
        deviceState: 'unknown'
      });
      assert.ok(run.finishedAt);
    }

    const interruptedAt = runOf(running.runId).finishedAt;
    const secondRestore = await reload();
    assert.equal(secondRestore.interruptedRuns, 0);
    assert.equal(runOf(running.runId).finishedAt, interruptedAt);

    const replay = beginAgentRun({
      operationId: 'running_operation',
      idempotencyKey: 'active:running'
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.runId, running.runId);
    assert.equal(replay.run.state, 'interrupted');
  });

  it('persists released idempotency keys so a retry creates a new run', async () => {
    await initialize();
    const first = beginAgentRun({
      operationId: 'fight',
      idempotencyKey: 'retry:after-rejection',
      input: { stage: '1-7' }
    }).run;
    failAgentRun(first.runId, {
      code: 'MAA_EXECUTION_BUSY',
      message: 'MAA 正在被其他任务使用',
      statusCode: 409
    });
    releaseAgentRunIdempotency(first.runId);
    await flushAgentRunStore();

    await reload();
    assert.equal(runOf(first.runId).state, 'failed');
    const retry = beginAgentRun({
      operationId: 'fight',
      idempotencyKey: 'retry:after-rejection',
      input: { stage: '1-7' }
    });
    assert.equal(retry.replayed, false);
    assert.notEqual(retry.run.runId, first.runId);
  });

  it('fails closed with a non-retryable store error when the persisted JSON is malformed', async () => {
    const original = '{"version":1,"runs":[';
    await writeFile(storePath, original, 'utf8');

    await assert.rejects(
      initialize(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
        && errorFields(error).retryable === false
    );
    assert.equal(await readFile(storePath, 'utf8'), original);
    assert.equal(getAgentRunStoreStatus().ready, false);
    assert.equal(getAgentRunStoreStatus().required, true);
    await assert.rejects(
      flushAgentRunStore(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).retryable === false
    );
    assert.throws(
      () => getAgentRun('unknown-run'),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).retryable === false
    );
  });

  it('keeps disk read failures retryable instead of treating them as corrupt JSON', async () => {
    await assert.rejects(
      initialize({
        readStore: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
      }),
      error => errorFields(error).code === 'AGENT_RUN_PERSISTENCE_FAILED'
        && errorFields(error).statusCode === 503
        && errorFields(error).retryable === true
    );
    assert.equal(getAgentRunStoreStatus().ready, false);
  });

  it('fails closed rather than overwriting an unsupported store version', async () => {
    const original = JSON.stringify({ version: 99, runs: [] });
    await writeFile(storePath, original, 'utf8');

    await assert.rejects(
      initialize(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
    );
    assert.equal(await readFile(storePath, 'utf8'), original);
    assert.equal(getAgentRunStoreStatus().ready, false);
    await assert.rejects(
      flushAgentRunStore(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
        && errorFields(error).retryable === false
    );
  });

  it('fails closed rather than treating a persisted null as a missing store', async () => {
    await writeFile(storePath, 'null', 'utf8');

    await assert.rejects(
      initialize(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
    );
    assert.equal(await readFile(storePath, 'utf8'), 'null');
    assert.equal(getAgentRunStoreStatus().ready, false);
  });

  it('rejects terminal records without a completion timestamp', async () => {
    await writeTerminalSnapshot({
      run: { finishedAt: null },
      finishedAtMs: null
    });

    await assert.rejects(
      initialize(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
    );
    assert.equal(getAgentRunStoreStatus().ready, false);
  });

  it('rejects terminal records without a positive terminal sequence', async () => {
    await writeTerminalSnapshot({ terminalSequence: null });

    await assert.rejects(
      initialize(),
      error => errorFields(error).code === 'AGENT_RUN_STORE_INVALID'
        && errorFields(error).statusCode === 503
    );
    assert.equal(getAgentRunStoreStatus().ready, false);
  });

  it('reports writer failures as retryable persistence errors', async () => {
    let writeAttempts = 0;
    await assert.rejects(
      initialize({
        writeStore: async () => {
          writeAttempts += 1;
          throw new Error('disk is read-only');
        }
      }),
      error => {
        const fields = errorFields(error);
        assert.equal(fields.code, 'AGENT_RUN_PERSISTENCE_FAILED');
        assert.equal(fields.statusCode, 503);
        assert.equal(fields.retryable, true);
        assert.equal(fields.details?.filePath, storePath);
        return true;
      }
    );
    assert.equal(writeAttempts, 1);
    assert.equal(getAgentRunStoreStatus().ready, false);
    const statusError = getAgentRunStoreStatus().error;
    assert.ok(statusError);
    assert.match(statusError, /disk is read-only/);
  });

  it('writes read-time TTL pruning back to disk so expired runs cannot reappear', async () => {
    const originalNow = Date.now;
    let now = Date.parse('2026-07-12T00:00:00.000Z');
    Date.now = () => now;
    try {
      await initialize();
      const expired = beginAgentRun({
        operationId: 'old_terminal',
        idempotencyKey: 'expired:key'
      }).run;
      completeAgentRun(expired.runId, { ok: true });
      await flushAgentRunStore();

      now += 24 * 60 * 60 * 1000 + 1;
      assert.equal(getAgentRun(expired.runId), null);
      await flushAgentRunStore();
      assert.deepEqual((await readSnapshot()).runs, []);

      await reload();
      const replacement = beginAgentRun({
        operationId: 'old_terminal',
        idempotencyKey: 'expired:key'
      });
      assert.equal(replacement.replayed, false);
      assert.notEqual(replacement.run.runId, expired.runId);
    } finally {
      Date.now = originalNow;
    }
  });

  it('persists a cron daily-flow run with its scheduler outcome', async () => {
    const previousLockFile = process.env.LA_PLUMA_MAA_LOCK_FILE;
    process.env.LA_PLUMA_MAA_LOCK_FILE = join(testDir, 'maa-execution.lock');
    try {
      await initialize();
      const result = await executeScheduledTaskFromCron([
        { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} },
        { id: 'infrast-1', commandId: 'infrast', name: '基建换班', enabled: true, params: { facility: [] } }
      ], 'cron-persisted');

      assert.equal(result.success, true);
      const stored = (await readSnapshot()).runs.find(item => item.run.operationId === 'run_daily_flow');
      assert.ok(stored, 'expected the cron flow to be persisted before it runs');
      assert.equal(stored.run.status, 'succeeded');
      const storedResult = stored.run.result as {
        scheduleId: string;
        totalSteps: number;
        summary: { skippedCount: number };
      };
      assert.equal(storedResult.scheduleId, 'cron-persisted');
      assert.equal(storedResult.totalSteps, 2);
      assert.equal(storedResult.summary.skippedCount, 2);
    } finally {
      if (previousLockFile === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE;
      else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLockFile;
    }
  });
});
