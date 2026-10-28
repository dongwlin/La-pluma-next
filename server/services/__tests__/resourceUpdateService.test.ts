import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ResourceUpdateTimeoutError,
  buildResourceInfo,
  createResourceUpdateService,
  parseResourceVersion
} from '../resourceUpdateService.ts';
import type {
  ResourceUpdateChild,
  ResourceUpdateService,
  ResourceUpdateSpawn
} from '../resourceUpdateService.ts';
import type { MaaExecutionLease, MaaExecutionLeaseRequest } from '../executionCoordinatorService.ts';

const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const now = new Date('2026-07-10T12:00:00.000Z');

/** 假更新脚本子进程：按注入的信号决定何时退出，便于断言时限升级。 */
class FakeUpdateChild extends EventEmitter implements ResourceUpdateChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: Array<NodeJS.Signals | number> = [];
  closeOnSignal: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    const expected = this.closeOnSignal;
    if (expected !== null && signal === expected) {
      queueMicrotask(() => this.emit('close', null, signal));
    }
    return true;
  }

  /** 按脚本输出顺序完成一次运行；`code` 非 0 表示失败。 */
  finish(code: number | null, { stdout = '', stderr = '' } = {}): void {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit('data', Buffer.from(stdout));
      if (stderr) this.stderr.emit('data', Buffer.from(stderr));
      this.emit('close', code, code === 0 ? null : 'SIGTERM');
    });
  }
}

interface LeaseHarness {
  request: MaaExecutionLeaseRequest;
  released: boolean;
  run: <T>(request: MaaExecutionLeaseRequest, callback: (lease: MaaExecutionLease) => Promise<T>) => Promise<T>;
}

function createLeaseHarness(): LeaseHarness {
  const harness: LeaseHarness = {
    request: {},
    released: false,
    async run(request, callback) {
      harness.request = request;
      const lease: MaaExecutionLease = {
        owner: {
          pid: 4242,
          source: String(request.source ?? ''),
          taskName: request.taskName ?? null,
          command: request.command ?? null,
          startedAt: '2026-07-10T12:00:00.000Z'
        },
        lockPath: '/virtual/maa-execution.lock',
        reentrant: false,
        release: async () => {
          harness.released = true;
        }
      };
      try {
        return await callback(lease);
      } finally {
        await lease.release();
      }
    }
  };
  return harness;
}

interface UpdateHarness {
  service: ResourceUpdateService;
  spawnCalls: Array<{ command: string; args: string[]; cwd: string }>;
  lease: LeaseHarness;
}

function createUpdateService(options: {
  children: FakeUpdateChild[];
  versionContent?: string;
  timeoutMs?: number | null;
  forceKillDelayMs?: number;
}): UpdateHarness {
  const spawnCalls: UpdateHarness['spawnCalls'] = [];
  const lease = createLeaseHarness();
  const versionContent = options.versionContent ?? JSON.stringify({
    last_updated: '2026-07-09 23:28:49.000',
    activity: { code: 'act-1' }
  });

  const spawnUpdate: ResourceUpdateSpawn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args: [...args], cwd: spawnOptions.cwd });
    const child = options.children.shift();
    assert.ok(child, 'unexpected update script spawn');
    return child;
  };

  const service = createResourceUpdateService({
    resolveResourceDir: async () => '/virtual/maa/resource',
    readVersionFile: async versionPath => {
      assert.equal(versionPath, '/virtual/maa/resource/version.json');
      return { content: versionContent, modifiedAt: new Date('2026-07-10T00:00:00.000Z') };
    },
    now: () => now,
    spawn: spawnUpdate,
    scriptPath: '/virtual/server/scripts/update-maa-resources.js',
    cwd: '/virtual/server',
    timeoutMs: options.timeoutMs ?? null,
    forceKillDelayMs: options.forceKillDelayMs,
    withLease: lease.run
  });

  return { service, spawnCalls, lease };
}

describe('buildResourceInfo', () => {
  it('marks recently updated resources as current', () => {
    const result = buildResourceInfo(
      { last_updated: '2026-07-09 23:28:49.000' },
      new Date('2026-07-10T00:00:00.000Z'),
      now
    );

    assert.equal(result.status, 'current');
    assert.equal(result.ageDays, 0);
    assert.equal(result.message, '资源版本正常');
  });

  it('marks resources older than two weeks as stale', () => {
    const result = buildResourceInfo(
      { last_updated: '2026-06-20 00:00:00.000' },
      new Date('2026-06-20T00:00:00.000Z'),
      now
    );

    assert.equal(result.status, 'stale');
    assert.equal(result.ageDays, 20);
    assert.match(result.message, /建议立即同步/);
  });

  it('treats exactly fourteen days as current and fifteen as stale', () => {
    const boundary = buildResourceInfo({ last_updated: '2026-06-26 12:00:00.000' }, null, now);
    assert.equal(boundary.ageDays, 14);
    assert.equal(boundary.status, 'current');

    const pastBoundary = buildResourceInfo({ last_updated: '2026-06-26 11:59:59.000' }, null, now);
    assert.equal(pastBoundary.ageDays, 14);
    assert.equal(pastBoundary.status, 'current');

    const stale = buildResourceInfo({ last_updated: '2026-06-25 00:00:00.000' }, null, now);
    assert.equal(stale.ageDays, 15);
    assert.equal(stale.status, 'stale');
  });

  it('handles missing version metadata', () => {
    const result = buildResourceInfo({}, null, now);

    assert.equal(result.status, 'unknown');
    assert.equal(result.ageDays, null);
    assert.match(result.message, /无法读取资源版本/);
  });

  it('keeps the file modification time and passes activity/gacha through', () => {
    const result = buildResourceInfo(
      {
        last_updated: '2026-07-09 23:28:49.000',
        activity: { code: 'act-1', name: '活动' },
        gacha: null
      },
      new Date('2026-07-10T00:00:00.000Z'),
      now
    );

    assert.equal(result.modifiedAt, '2026-07-10T00:00:00.000Z');
    assert.deepEqual(result.activity, { code: 'act-1', name: '活动' });
    assert.equal(result.gacha, null);
  });

  it('narrows non-record version data and unparsable timestamps', () => {
    for (const versionData of [null, 'not-a-record', 42, ['2026-07-09']]) {
      const result = buildResourceInfo(versionData, null, now);
      assert.equal(result.status, 'unknown');
      assert.equal(result.lastUpdated, null);
      assert.equal(result.modifiedAt, null);
      assert.equal(result.activity, null);
      assert.equal(result.gacha, null);
    }

    // 非 Date 的文件时间来自注入值，按未知处理而不是原样透传。
    const invalidModified = buildResourceInfo({}, 'not-a-date' as unknown as Date, now);
    assert.equal(invalidModified.modifiedAt, null);

    const invalidTimestamp = buildResourceInfo({ last_updated: 'not-a-date' }, null, now);
    assert.equal(invalidTimestamp.status, 'unknown');
    assert.equal(invalidTimestamp.ageDays, null);
    assert.equal(invalidTimestamp.lastUpdated, 'not-a-date');
  });
});

describe('parseResourceVersion', () => {
  it('parses the version file into the narrowed metadata shape', () => {
    const metadata = parseResourceVersion(JSON.stringify({
      last_updated: '2026-07-09 23:28:49.000',
      activity: { code: 'act-1' },
      gacha: 0
    }));

    assert.equal(metadata.lastUpdated, '2026-07-09 23:28:49.000');
    assert.deepEqual(metadata.activity, { code: 'act-1' });
    assert.equal(metadata.gacha, null);
  });

  it('rejects malformed JSON and treats non-object payloads as unknown', () => {
    assert.throws(() => parseResourceVersion('{not-json'), SyntaxError);

    const metadata = parseResourceVersion('"resource"');
    assert.equal(metadata.lastUpdated, null);
    assert.equal(metadata.activity, null);
    assert.equal(metadata.gacha, null);
  });
});

describe('resource info reads', () => {
  it('reads version.json under the CLI resource directory', async () => {
    const resourceDir = await createTemporaryDirectory('la-pluma-resource-info-');
    await writeFile(join(resourceDir, 'version.json'), JSON.stringify({
      last_updated: '2026-07-09 23:28:49.000',
      activity: { code: 'act-1' }
    }), 'utf-8');

    const service = createResourceUpdateService({
      resolveResourceDir: async () => resourceDir,
      now: () => now
    });
    const info = await service.getResourceInfo();

    assert.equal(info.status, 'current');
    assert.equal(info.ageDays, 0);
    assert.equal(info.lastUpdated, '2026-07-09 23:28:49.000');
    assert.match(info.modifiedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(info.activity, { code: 'act-1' });
  });

  it('propagates unreadable version files instead of inventing a status', async () => {
    const resourceDir = await createTemporaryDirectory('la-pluma-resource-missing-');
    const service = createResourceUpdateService({
      resolveResourceDir: async () => resourceDir
    });

    await assert.rejects(
      service.getResourceInfo(),
      error => (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  });
});

describe('resource updates', () => {
  it('shares one in-flight update and reports the refreshed resource info', async () => {
    const child = new FakeUpdateChild();
    const harness = createUpdateService({ children: [child] });

    const first = harness.service.updateResources();
    const second = harness.service.updateResources();
    child.finish(0, { stdout: '资源文件更新成功\n' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(harness.spawnCalls.length, 1);
    assert.equal(harness.lease.request.source, 'resource-update');
    assert.equal(harness.lease.request.taskName, '同步 MAA 资源');
    assert.equal(harness.lease.request.command, 'hot-update');
    assert.equal(harness.lease.released, true);
    assert.equal(firstResult, secondResult);
    assert.equal(firstResult.output, '资源文件更新成功\n');
    assert.equal(firstResult.resource.status, 'current');
    assert.equal(harness.spawnCalls[0].command, 'node');
    assert.deepEqual(harness.spawnCalls[0].args, ['/virtual/server/scripts/update-maa-resources.js']);
    assert.equal(harness.spawnCalls[0].cwd, '/virtual/server');
  });

  it('does not cancel the shared update when one caller stops awaiting', async () => {
    const child = new FakeUpdateChild();
    const harness = createUpdateService({ children: [child] });

    void harness.service.updateResources();
    const remaining = harness.service.updateResources();
    child.finish(0, { stdout: 'ok\n' });

    const result = await remaining;
    assert.equal(result.output, 'ok\n');
    assert.equal(harness.spawnCalls.length, 1);
    assert.equal(harness.lease.released, true);
  });

  it('reports script failures once without an automatic retry', async () => {
    const failingChild = new FakeUpdateChild();
    const retryChild = new FakeUpdateChild();
    const harness = createUpdateService({ children: [failingChild, retryChild] });

    const first = harness.service.updateResources();
    const second = harness.service.updateResources();
    failingChild.finish(1, { stderr: 'git clone 失败\n' });

    await assert.rejects(first, /git clone 失败/);
    await assert.rejects(second, /git clone 失败/);
    assert.equal(harness.spawnCalls.length, 1, '失败后不能自动重试');
    assert.equal(harness.lease.released, true);

    const retry = harness.service.updateResources();
    retryChild.finish(0, { stdout: 'ok\n' });
    const result = await retry;

    assert.equal(harness.spawnCalls.length, 2, '显式的新请求才启动新的更新');
    assert.equal(result.output, 'ok\n');
  });

  it('falls back to the captured output when the script exits without stderr', async () => {
    const child = new FakeUpdateChild();
    const harness = createUpdateService({ children: [child] });

    const update = harness.service.updateResources();
    child.finish(2, { stdout: '部分输出' });

    await assert.rejects(update, /部分输出/);
    assert.equal(harness.spawnCalls.length, 1);
  });

  it('terminates an explicit timeout with SIGTERM then SIGKILL and never retries', async () => {
    const child = new FakeUpdateChild();
    child.closeOnSignal = 'SIGKILL';
    const harness = createUpdateService({
      children: [child],
      timeoutMs: 10,
      forceKillDelayMs: 10
    });

    const update = harness.service.updateResources();

    await assert.rejects(update, error => {
      assert.ok(error instanceof ResourceUpdateTimeoutError);
      assert.equal(error.code, 'MAA_RESOURCE_UPDATE_TIMEOUT');
      assert.equal(error.timeoutMs, 10);
      assert.match(error.message, /资源更新超时（10ms）/);
      return true;
    });
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(harness.spawnCalls.length, 1);
    assert.equal(harness.lease.released, true);
  });

  it('surfaces spawn errors without retrying', async () => {
    const child = new FakeUpdateChild();
    const harness = createUpdateService({ children: [child] });
    const spawnFailure = new Error('spawn node ENOENT');

    const update = harness.service.updateResources();
    queueMicrotask(() => child.emit('error', spawnFailure));

    await assert.rejects(update, error => error === spawnFailure);
    assert.equal(harness.spawnCalls.length, 1);
    assert.equal(harness.lease.released, true);
  });

  it('removes the in-flight update after a refresh failure', async () => {
    const child = new FakeUpdateChild();
    const successfulChild = new FakeUpdateChild();
    let reads = 0;
    const spawnCalls: string[] = [];
    const service = createResourceUpdateService({
      resolveResourceDir: async () => '/virtual/maa/resource',
      readVersionFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error('版本文件不可读');
        return { content: JSON.stringify({ last_updated: '2026-07-09 23:28:49.000' }), modifiedAt: now };
      },
      now: () => now,
      spawn: (_command, args) => {
        spawnCalls.push(args[0]);
        const next = spawnCalls.length === 1 ? child : successfulChild;
        return next;
      },
      withLease: async (_request, callback) => callback({
        owner: { pid: 1, source: 'test', taskName: null, command: null, startedAt: '' },
        lockPath: '/virtual/lock',
        reentrant: false,
        release: async () => {}
      })
    });

    const failing = service.updateResources();
    child.finish(0, { stdout: 'ok\n' });
    await assert.rejects(failing, /版本文件不可读/);

    const retry = service.updateResources();
    successfulChild.finish(0, { stdout: 'ok\n' });
    const result = await retry;

    assert.equal(spawnCalls.length, 2);
    assert.equal(result.resource.status, 'current');
  });
});
