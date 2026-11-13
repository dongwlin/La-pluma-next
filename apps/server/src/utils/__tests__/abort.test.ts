import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { waitWithAbort } from '../abort.ts';

describe('abortable waits', () => {
  it('does not start an operation if cancellation arrives before its microtask', async () => {
    const controller = new AbortController();
    const waiting = waitWithAbort(() => assert.fail('cancelled operation must not start'), controller.signal);
    controller.abort(new Error('cancel before invocation'));
    await assert.rejects(waiting, error => error === controller.signal.reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('removes its listener after success and after rejection', async () => {
    const controller = new AbortController();
    assert.equal(await waitWithAbort(async () => 42, controller.signal), 42);
    const failure = new Error('operation failed');
    await assert.rejects(waitWithAbort(async () => { throw failure; }, controller.signal), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('observes a late rejection after the caller has already cancelled', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<void>();
    const waiting = waitWithAbort(() => { entered.resolve(); return operation.promise; }, controller.signal);
    await entered.promise;
    controller.abort();
    await assert.rejects(waiting, error => error === controller.signal.reason);
    operation.reject(new Error('late failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});
