import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MaaExecutionBusyError,
  acquireMaaExecutionLease,
  getMaaExecutionLeaseSnapshot,
  withMaaExecutionLease
} from '../executionCoordinatorService.ts';

test('execution lease is exclusive and released after use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-lock-'));
  process.env.LA_PLUMA_MAA_LOCK_FILE = join(dir, 'maa.lock');
  try {
    const lease = await acquireMaaExecutionLease({ taskName: 'first' });
    await assert.rejects(
      acquireMaaExecutionLease({ taskName: 'second' }),
      error => error instanceof MaaExecutionBusyError && error.owner?.taskName === 'first'
    );
    await lease.release();
    const nextLease = await acquireMaaExecutionLease({ taskName: 'second' });
    await nextLease.release();
  } finally {
    delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('execution lease supports nested use in the same async flow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-lock-'));
  process.env.LA_PLUMA_MAA_LOCK_FILE = join(dir, 'maa.lock');
  try {
    await withMaaExecutionLease({ taskName: 'workflow' }, async outer => {
      await withMaaExecutionLease({ taskName: 'stage' }, async inner => {
        assert.equal(inner.lockPath, outer.lockPath);
        const metadata = JSON.parse(await readFile(outer.lockPath, 'utf8'));
        assert.equal(metadata.taskName, 'workflow');
      });
    });
  } finally {
    delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale lock owned by a dead process is recovered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-lock-'));
  const lockPath = join(dir, 'maa.lock');
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockPath;
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, taskName: 'stale' }));
    const lease = await acquireMaaExecutionLease({ taskName: 'recovered' });
    assert.equal(lease.owner.taskName, 'recovered');
    await lease.release();
  } finally {
    delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('treats an empty or malformed lock as unknown instead of reclaiming it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-lock-'));
  const lockPath = join(dir, 'maa.lock');
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockPath;
  try {
    for (const contents of ['', '{"pid":', 'null', '{"pid":"not-a-pid"}']) {
      await writeFile(lockPath, contents);
      assert.deepEqual(await getMaaExecutionLeaseSnapshot(), {
        state: 'unknown',
        owner: null,
        reason: contents === '' || contents === '{"pid":' ? 'invalid_json' : 'invalid_owner'
      });
      await assert.rejects(
        acquireMaaExecutionLease({ taskName: 'must-not-reclaim' }),
        error => error instanceof MaaExecutionBusyError && error.owner === null
      );
      assert.equal(await readFile(lockPath, 'utf8'), contents);
    }
  } finally {
    delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishes a complete lock file and releases only its own record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-lock-'));
  const lockPath = join(dir, 'maa.lock');
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockPath;
  try {
    const lease = await acquireMaaExecutionLease({ taskName: 'atomic' });
    const published = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(published.pid, process.pid);
    assert.equal(published.taskName, 'atomic');
    assert.deepEqual(await readdir(dir), ['maa.lock']);

    // 未知内容不能被释放路径顺手删除；下一次获取会按占用拒绝而不是双持有。
    await writeFile(lockPath, '{"pid":');
    await lease.release();
    assert.equal(await readFile(lockPath, 'utf8'), '{"pid":');
    await assert.rejects(
      acquireMaaExecutionLease({ taskName: 'after-unknown' }),
      error => error instanceof MaaExecutionBusyError && error.owner === null
    );
  } finally {
    delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});
