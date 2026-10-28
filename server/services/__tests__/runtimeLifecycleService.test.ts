import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CLOSE_DEADLINE_MS,
  RuntimeLifecycleError,
  createRuntimeLifecycle
} from '../runtimeLifecycleService.ts';
import type { RuntimeLifecycleLogger } from '../runtimeLifecycleService.ts';

const silentLogger: RuntimeLifecycleLogger = {
  info() {},
  warn() {},
  error() {}
};

function isLifecycleError(code: string, stepName: string | null = null) {
  return (error: unknown) => {
    assert.ok(error instanceof RuntimeLifecycleError);
    assert.equal(error.code, code);
    assert.equal(error.stepName, stepName);
    return true;
  };
}

describe('runtime lifecycle', () => {
  it('starts in registration order and closes in reverse order', async () => {
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1000 });
    lifecycle.register({
      name: 'store',
      start: () => { events.push('start:store'); },
      close: () => { events.push('close:store'); }
    });
    lifecycle.register({
      name: 'transport',
      start: async () => { events.push('start:transport'); },
      close: async () => { events.push('close:transport'); }
    });
    lifecycle.register({
      name: 'runtime',
      start: () => { events.push('start:runtime'); },
      close: () => { events.push('close:runtime'); }
    });

    const started = await lifecycle.start();

    assert.deepEqual(events, ['start:store', 'start:transport', 'start:runtime']);
    assert.deepEqual(started.started, ['store', 'transport', 'runtime']);
    assert.equal(lifecycle.getState(), 'running');
    assert.equal(lifecycle.isDraining(), false);
    assert.equal(lifecycle.getCloseSummary(), null);

    // 重复 start 不重跑启动步骤，返回同一份摘要。
    const startedAgain = await lifecycle.start();
    assert.equal(startedAgain, started);
    assert.deepEqual(events, ['start:store', 'start:transport', 'start:runtime']);

    const summary = await lifecycle.close('test');

    assert.deepEqual(events.slice(3), ['close:runtime', 'close:transport', 'close:store']);
    assert.deepEqual(summary.steps.map(step => step.name), ['runtime', 'transport', 'store']);
    assert.ok(summary.steps.every(step => step.status === 'closed'));
    assert.equal(summary.ok, true);
    assert.equal(summary.state, 'closed');
    assert.equal(summary.reason, 'test');
    assert.equal(lifecycle.getState(), 'closed');
    assert.equal(lifecycle.isDraining(), true);
    assert.equal(lifecycle.getCloseSummary(), summary);
  });

  it('reuses the first close result for repeated and concurrent calls', async () => {
    const closes: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1000 });
    lifecycle.register({
      name: 'resource',
      close: () => { closes.push('resource'); }
    });
    await lifecycle.start();

    const first = lifecycle.close('first');
    const concurrent = lifecycle.close('second');
    const [firstSummary, concurrentSummary] = await Promise.all([first, concurrent]);
    const repeatedSummary = await lifecycle.close('third');

    assert.equal(firstSummary, concurrentSummary);
    assert.equal(firstSummary, repeatedSummary);
    assert.equal(firstSummary.reason, 'first');
    assert.deepEqual(closes, ['resource']);
    assert.deepEqual(firstSummary.steps.map(step => step.name), ['resource']);
  });

  it('rolls back started steps in reverse order when a later start fails', async () => {
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1000 });
    lifecycle.register({
      name: 'store',
      start: () => { events.push('start:store'); },
      close: () => { events.push('close:store'); }
    });
    lifecycle.register({
      name: 'transport',
      start: () => {
        events.push('start:transport');
        throw new Error('listen EADDRINUSE');
      },
      close: () => { events.push('close:transport'); }
    });
    lifecycle.register({
      name: 'runtime',
      start: () => { events.push('start:runtime'); }
    });

    await assert.rejects(
      lifecycle.start(),
      isLifecycleError('RUNTIME_LIFECYCLE_START_FAILED', 'transport')
    );

    assert.deepEqual(events, [
      'start:store',
      'start:transport',
      'close:transport',
      'close:store'
    ]);
    assert.equal(lifecycle.getState(), 'start-failed');
    assert.throws(
      () => lifecycle.register({ name: 'after-failure', close: () => {} }),
      isLifecycleError('RUNTIME_LIFECYCLE_CLOSED', 'after-failure')
    );

    // 启动失败已回收的资源不会在之后显式关闭时重复释放。
    const summary = await lifecycle.close('after-failure');
    assert.deepEqual(events, [
      'start:store',
      'start:transport',
      'close:transport',
      'close:store'
    ]);
    assert.deepEqual(summary.steps, []);
    assert.equal(lifecycle.getState(), 'closed');
  });

  it('continues remaining cleanup when one step fails', async () => {
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1000 });
    lifecycle.register({
      name: 'store',
      close: () => { events.push('store'); }
    });
    lifecycle.register({
      name: 'flush',
      close: () => {
        events.push('flush');
        throw new Error('flush failed');
      }
    });
    lifecycle.register({
      name: 'transport',
      close: () => { events.push('transport'); }
    });
    await lifecycle.start();

    const summary = await lifecycle.close('failure');

    assert.deepEqual(events, ['transport', 'flush', 'store']);
    assert.deepEqual(summary.steps.map(step => step.status), ['closed', 'failed', 'closed']);
    assert.equal(summary.steps[1].error, 'flush failed');
    assert.equal(summary.ok, false);
  });

  it('bounds a hanging step with the shared deadline without blocking others', async () => {
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 300 });
    lifecycle.register({
      name: 'store',
      close: () => { events.push('store'); }
    });
    lifecycle.register({
      name: 'hung',
      close: () => new Promise<void>(() => {})
    });
    lifecycle.register({
      name: 'transport',
      close: () => { events.push('transport'); }
    });
    await lifecycle.start();

    const startedAt = Date.now();
    const summary = await lifecycle.close('timeout');
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(summary.steps.map(step => step.name), ['transport', 'hung', 'store']);
    assert.deepEqual(summary.steps.map(step => step.status), ['closed', 'timeout', 'closed']);
    assert.deepEqual(events, ['transport', 'store']);
    assert.equal(summary.ok, false);
    assert.ok(elapsed < 1000, `close should stay near the 300ms budget, took ${elapsed}ms`);
  });

  it('stops starting new steps and rejects registrations once draining begins', async () => {
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1000 });
    lifecycle.register({
      name: 'store',
      start: () => { events.push('start:store'); },
      close: () => { events.push('close:store'); }
    });
    let releaseTransport = () => {};
    lifecycle.register({
      name: 'transport',
      start: () => new Promise<void>(resolve => {
        events.push('start:transport');
        releaseTransport = resolve;
      }),
      close: () => { events.push('close:transport'); }
    });
    lifecycle.register({
      name: 'runtime',
      start: () => { events.push('start:runtime'); }
    });

    const starting = lifecycle.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    const closing = lifecycle.close('signal');
    assert.equal(lifecycle.isDraining(), true);
    assert.throws(
      () => lifecycle.register({ name: 'late', close: () => {} }),
      isLifecycleError('RUNTIME_LIFECYCLE_CLOSED', 'late')
    );
    releaseTransport();

    await starting;
    const summary = await closing;

    assert.ok(!events.includes('start:runtime'));
    assert.deepEqual(events.filter(event => event.startsWith('close:')), ['close:transport', 'close:store']);
    assert.equal(summary.ok, true);
  });

  it('closes registrations quietly when shutdown happens before startup', async () => {
    const closes: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger });
    lifecycle.register({
      name: 'resource',
      start: () => {},
      close: () => { closes.push('resource'); }
    });

    const summary = await lifecycle.close('early');

    assert.deepEqual(summary.steps, []);
    assert.deepEqual(closes, []);
    assert.equal(summary.ok, true);
    assert.equal(lifecycle.getState(), 'closed');
    await assert.rejects(lifecycle.start(), isLifecycleError('RUNTIME_LIFECYCLE_CLOSED'));
    assert.throws(
      () => lifecycle.register({ name: 'after-close', close: () => {} }),
      isLifecycleError('RUNTIME_LIFECYCLE_CLOSED', 'after-close')
    );
  });

  it('releases already-owned resources even before startup', async () => {
    const closes: string[] = [];
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger });
    lifecycle.register({ name: 'owned', close: () => { closes.push('owned'); } });
    lifecycle.register({ name: 'not-started', start: () => {}, close: () => { closes.push('not-started'); } });

    const summary = await lifecycle.close('before-start');

    assert.equal(summary.ok, true);
    assert.deepEqual(closes, ['owned']);
    assert.deepEqual(summary.steps.map(step => step.name), ['owned']);
  });

  for (const outcome of ['close', 'failure'] as const) {
    it(`releases resources registered by an in-flight initializer on ${outcome}`, async () => {
      const events: string[] = [];
      const lifecycle = createRuntimeLifecycle({ logger: silentLogger });
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      lifecycle.register({
        name: 'initializer',
        start: async () => {
          lifecycle.register({ name: 'owned-domain', close: () => { events.push('domain'); } });
          entered();
          await hold;
          if (outcome === 'failure') throw new Error('fixture initialization failure');
        },
        close: () => { events.push('initializer'); }
      });
      const starting = lifecycle.start();
      await started;
      const closing = outcome === 'close' ? lifecycle.close('during-start') : null;
      release();
      if (outcome === 'failure') {
        await assert.rejects(starting, isLifecycleError('RUNTIME_LIFECYCLE_START_FAILED', 'initializer'));
      } else {
        await starting;
        assert.equal((await closing)?.ok, true);
      }
      assert.deepEqual(events, ['domain', 'initializer']);
      await lifecycle.close('cleanup');
      assert.deepEqual(events, ['domain', 'initializer']);
    });
  }

  it('rejects duplicate names, invalid deadlines and late start steps', async () => {
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger });
    lifecycle.register({ name: 'same', close: () => {} });
    assert.throws(
      () => lifecycle.register({ name: 'same', close: () => {} }),
      isLifecycleError('RUNTIME_LIFECYCLE_DUPLICATE', 'same')
    );
    assert.throws(
      () => createRuntimeLifecycle({ closeDeadlineMs: 0 }),
      isLifecycleError('RUNTIME_LIFECYCLE_INVALID')
    );
    assert.equal(DEFAULT_CLOSE_DEADLINE_MS, 10_000);

    await lifecycle.start();
    assert.throws(
      () => lifecycle.register({ name: 'late-start', start: () => {} }),
      isLifecycleError('RUNTIME_LIFECYCLE_INVALID', 'late-start')
    );
    // 启动完成后仍可注册只有释放能力的领域步骤（例如运行时恢复阶段创建的资源），
    // 这些步骤直接纳入关闭顺序。
    let lateClosed = false;
    lifecycle.register({
      name: 'late-close',
      close: () => { lateClosed = true; }
    });
    const summary = await lifecycle.close('late-close');
    assert.equal(lateClosed, true);
    assert.deepEqual(summary.steps.map(step => step.name), ['late-close', 'same']);
    assert.equal(summary.ok, true);
  });
});
