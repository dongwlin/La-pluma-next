import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ExecutionOutcome,
  RoguelikeTaskCapturePorts,
  RoguelikeTaskCaptureRun,
  TrackedExecutionLifecycle
} from '../controllers/agentExecutionController.ts';
import { runRoguelikeTaskWithCapture } from '../controllers/agentExecutionController.ts';
import { MaaExecutionBusyError } from '../services/executionCoordinatorService.ts';
import type { MaaExecutionLease } from '../services/executionCoordinatorService.ts';

const ROGUELIKE_SESSION_LOG = [
  'Assistant::append_callback | SubTaskStart {"taskchain":"Roguelike"}',
  'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"Roguelike","what":"RoguelikeSettlement","details":{"floor":4,"step":23,"score":128}}',
  'Assistant::append_callback | TaskChainCompleted {"taskchain":"Roguelike"}'
].join('\n');

const RUN: Omit<RoguelikeTaskCaptureRun, 'execute'> = {
  target: { command: 'roguelike', args: ['Sarkaz'] },
  lease: { source: 'agent', taskName: 'Agent: roguelike', command: 'roguelike' },
  waitForCompletion: true,
  lifecycle: {}
};

function fakeLease(events: string[]): MaaExecutionLease {
  return {
    owner: {
      pid: process.pid,
      source: 'agent',
      taskName: 'Agent: roguelike',
      command: 'roguelike',
      startedAt: new Date(0).toISOString()
    },
    lockPath: '/virtual/maa-execution.lock',
    reentrant: false,
    release: async () => {
      events.push('release');
    }
  };
}

function incrementalPorts(
  events: string[],
  readLog: () => string
): RoguelikeTaskCapturePorts {
  const lease = fakeLease(events);
  return {
    acquireLease: async request => {
      events.push(`acquire:${request.command}`);
      return lease;
    },
    runWithLease: (_lease, callback) => callback(),
    createCheckpoint: async () => {
      events.push('checkpoint');
      return { logPath: '/virtual/asst.log', size: readLog().length };
    },
    readLogSince: async checkpoint => {
      events.push('read');
      return readLog().slice(checkpoint?.size ?? 0);
    }
  };
}

function summaryOf(value: unknown): { status?: string; observed?: boolean } | undefined {
  return (value as { summary?: { status?: string; observed?: boolean } } | null)?.summary;
}

function errorSummaryOf(error: unknown): { status?: string; observed?: boolean } | undefined {
  const details = (error as { details?: { summary?: { status?: string; observed?: boolean } } } | null)?.details;
  return details?.summary;
}

test('同步执行在租约内创建检查点，并在释放租约前采集摘要', async () => {
  const events: string[] = [];
  let logText = 'previous session tail\n';

  const result = await runRoguelikeTaskWithCapture(
    {
      ...RUN,
      execute: async lifecycle => {
        events.push('execute');
        await lifecycle.onBeforeStart?.();
        lifecycle.onStarted?.();
        logText += `${ROGUELIKE_SESSION_LOG}\n`;
        return { ok: true };
      }
    },
    incrementalPorts(events, () => logText)
  );

  assert.deepEqual(events, ['acquire:roguelike', 'checkpoint', 'execute', 'read', 'release']);
  const summary = summaryOf(result);
  assert.equal(summary?.status, 'success');
  assert.equal(summary?.observed, true);
});

test('同步失败同样在释放租约前读取本次增量并挂到错误详情', async () => {
  const events: string[] = [];
  let logText = 'previous session tail\n';
  const failure = Object.assign(new Error('任务已终止'), { stopped: true });

  await assert.rejects(
    runRoguelikeTaskWithCapture(
      {
        ...RUN,
        execute: async lifecycle => {
          lifecycle.onStarted?.();
          logText += `${ROGUELIKE_SESSION_LOG}\n`;
          throw failure;
        }
      },
      incrementalPorts(events, () => logText)
    ),
    error => {
      assert.equal(error, failure);
      assert.equal(errorSummaryOf(failure)?.status, 'success');
      return true;
    }
  );

  assert.deepEqual(events, ['acquire:roguelike', 'checkpoint', 'read', 'release']);
});

test('异步执行在租约内采集摘要后再结算并释放租约', async () => {
  const events: string[] = [];
  const settled: ExecutionOutcome[] = [];
  let logText = 'previous session tail\n';
  const capturedLifecycle: { current: TrackedExecutionLifecycle | null } = { current: null };

  await runRoguelikeTaskWithCapture(
    {
      ...RUN,
      waitForCompletion: false,
      lifecycle: {
        onSettled: async outcome => {
          events.push('settle');
          settled.push(outcome);
        }
      },
      execute: async lifecycle => {
        capturedLifecycle.current = lifecycle;
        lifecycle.onStarted?.();
        events.push('started');
        logText += `${ROGUELIKE_SESSION_LOG}\n`;
        return { accepted: true };
      }
    },
    incrementalPorts(events, () => logText)
  );

  assert.deepEqual(events, ['acquire:roguelike', 'checkpoint', 'started']);
  assert.equal(settled.length, 0);

  await capturedLifecycle.current?.onSettled?.({ ok: true, result: { accepted: true } });

  assert.deepEqual(events, ['acquire:roguelike', 'checkpoint', 'started', 'read', 'settle', 'release']);
  assert.equal(settled.length, 1);
  const summary = summaryOf(settled[0]?.result);
  assert.equal(summary?.status, 'success');
  assert.equal(summary?.observed, true);
});

test('设备占用被拒的请求不创建检查点、不读取日志、不产生摘要', async () => {
  const events: string[] = [];
  const busy = new MaaExecutionBusyError({
    pid: 424242,
    source: 'agent',
    taskName: '其它 Run',
    command: 'roguelike',
    startedAt: new Date(0).toISOString()
  });

  await assert.rejects(
    runRoguelikeTaskWithCapture(
      {
        ...RUN,
        execute: async () => {
          events.push('execute');
          return { ok: true };
        }
      },
      {
        acquireLease: async () => {
          events.push('acquire');
          throw busy;
        },
        runWithLease: (_lease, callback) => callback(),
        createCheckpoint: async () => {
          events.push('checkpoint');
          return { logPath: '/virtual/asst.log', size: 0 };
        },
        readLogSince: async () => {
          events.push('read');
          return ROGUELIKE_SESSION_LOG;
        }
      }
    ),
    error => {
      assert.equal(error, busy);
      assert.equal(busy.code, 'MAA_EXECUTION_BUSY');
      assert.equal(errorSummaryOf(busy), undefined);
      return true;
    }
  );

  assert.deepEqual(events, ['acquire']);
});

test('被前启动门禁拒绝的执行跳过摘要采集并释放租约', async () => {
  const events: string[] = [];
  const gateError = Object.assign(new Error('Run 已停止'), { code: 'AGENT_RUN_STOPPED' });

  await assert.rejects(
    runRoguelikeTaskWithCapture(
      {
        ...RUN,
        execute: async lifecycle => {
          events.push('execute');
          await lifecycle.onBeforeStart?.();
          throw gateError;
        }
      },
      {
        ...incrementalPorts(events, () => ROGUELIKE_SESSION_LOG),
        createCheckpoint: async () => {
          events.push('checkpoint');
          return { logPath: '/virtual/asst.log', size: 0 };
        }
      }
    ),
    error => {
      assert.equal(error, gateError);
      assert.equal((gateError as { details?: { summary?: unknown } }).details?.summary, undefined);
      return true;
    }
  );

  assert.deepEqual(events, ['acquire:roguelike', 'checkpoint', 'execute', 'release']);
});

test('检查点创建失败时保留执行本身，仅跳过摘要', async () => {
  const events: string[] = [];
  const lease = fakeLease(events);

  const result = await runRoguelikeTaskWithCapture(
    {
      ...RUN,
      execute: async lifecycle => {
        lifecycle.onStarted?.();
        return { ok: true };
      }
    },
    {
      acquireLease: async () => lease,
      runWithLease: (_lease, callback) => callback(),
      createCheckpoint: async () => {
        throw new Error('no log dir');
      },
      readLogSince: async () => {
        events.push('read');
        return ROGUELIKE_SESSION_LOG;
      }
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ['release']);
});
