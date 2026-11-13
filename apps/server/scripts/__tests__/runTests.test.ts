import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveConcurrency, runTestFiles } from '../run-tests.ts';
import type { TestFileRunner } from '../run-tests.ts';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not met');
};

describe('test run concurrency', () => {
  it('defaults to a bounded worker count and accepts an explicit override', () => {
    assert.equal(resolveConcurrency(undefined, 16), 4);
    assert.equal(resolveConcurrency(undefined, 2), 2);
    assert.equal(resolveConcurrency(undefined, 1), 1);
    assert.equal(resolveConcurrency('6', 16), 6);
    assert.equal(resolveConcurrency(' 3 ', 16), 3);
  });

  it('rejects values that are not positive integers', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '2x']) {
      assert.throws(() => resolveConcurrency(value, 16), /LA_PLUMA_TEST_CONCURRENCY/);
    }
  });

  it('keeps one process per file, caps in-flight files and prints in file order', async () => {
    const entries = ['a', 'b', 'c'].map(file => ({ file, label: `${file}.test.ts` }));
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const writes: string[] = [];
    let active = 0;
    let peak = 0;

    const run: TestFileRunner = async file => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(file);
      await new Promise<void>(resolve => {
        gates.set(file, resolve);
      });
      active -= 1;
      return { exitCode: 0, signal: null, output: `out:${file}` };
    };

    const task = runTestFiles(entries, { concurrency: 2, run, write: chunk => writes.push(chunk) });
    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ['a', 'b']);

    gates.get('b')?.();
    await waitFor(() => started.length === 3);
    assert.equal(writes.length, 0, 'a finished later file must not print before earlier files');

    gates.get('a')?.();
    await waitFor(() => writes.length === 2);
    assert.match(writes[0] ?? '', /▶ a\.test\.ts[\s\S]*out:a/);
    assert.match(writes[1] ?? '', /▶ b\.test\.ts[\s\S]*out:b/);

    gates.get('c')?.();
    const results = await task;
    assert.equal(peak, 2);
    assert.deepEqual(results.map(result => result.entry.file), ['a', 'b', 'c']);
    assert.match(writes[2] ?? '', /▶ c\.test\.ts[\s\S]*out:c/);
  });

  it('returns failed exits and signals unchanged', async () => {
    const entries = [{ file: 'broken.test.ts', label: 'broken.test.ts' }];
    const run: TestFileRunner = async () => ({ exitCode: 1, signal: null, output: 'boom\n' });

    const results = await runTestFiles(entries, { concurrency: 1, run, write: () => {} });

    assert.equal(results[0]?.exitCode, 1);
    assert.equal(results[0]?.signal, null);
    assert.equal(results[0]?.output, 'boom\n');
  });
});
