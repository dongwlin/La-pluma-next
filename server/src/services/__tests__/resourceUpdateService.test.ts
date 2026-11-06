import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildResourceInfo,
  createResourceUpdateService,
  parseResourceVersion
} from '../resourceUpdateService.ts';
import type {
  ResourceUpdateResult,
  ResourceUpdateService
} from '../resourceUpdateService.ts';
import { MaaExecutionBusyError } from '../executionCoordinatorService.ts';
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
const baseDir = '/virtual/maa/resource';
const hotUpdateDir = '/virtual/maa/MaaResource/resource';

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
  versionFiles: Map<string, string | null>;
  calls: string[];
  lease: LeaseHarness;
  setVersion(resourceDir: string, lastUpdated: string): void;
}

function metadataContent(lastUpdated: string): string {
  return JSON.stringify({ last_updated: lastUpdated, activity: { code: 'act-1' } });
}

function createUpdateService(options: {
  resourceDirs?: string[];
  hotUpdateResult?: () => Promise<string>;
  hotUpdateError?: () => Error | null;
} = {}): UpdateHarness {
  const resourceDirs = options.resourceDirs ?? [baseDir];
  const versionFiles = new Map<string, string | null>();
  for (const dir of resourceDirs) {
    versionFiles.set(dir, metadataContent('2026-07-09 23:28:49.000'));
  }
  const calls: string[] = [];
  const lease = createLeaseHarness();

  const service = createResourceUpdateService({
    resolveResourceDirs: async () => resourceDirs,
    readVersionFile: async versionPath => {
      const dir = dirname(versionPath);
      const content = versionFiles.get(dir);
      if (content === null || content === undefined) {
        const error = new Error(`ENOENT: ${versionPath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { content, modifiedAt: new Date('2026-07-10T00:00:00.000Z') };
    },
    now: () => now,
    runHotUpdate: async () => {
      calls.push('hot-update');
      const error = options.hotUpdateError?.();
      if (error) throw error;
      return options.hotUpdateResult ? options.hotUpdateResult() : 'Hot update completed successfully\n';
    },
    withLease: lease.run
  });

  return {
    service,
    versionFiles,
    calls,
    lease,
    setVersion(resourceDir, lastUpdated) {
      versionFiles.set(resourceDir, metadataContent(lastUpdated));
    }
  };
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

    const invalidModified = buildResourceInfo({}, 'not-a-date', now);
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
    await writeFile(join(resourceDir, 'version.json'), metadataContent('2026-07-09 23:28:49.000'), 'utf-8');

    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [resourceDir],
      now: () => now
    });
    const info = await service.getResourceInfo();

    assert.equal(info.status, 'current');
    assert.equal(info.ageDays, 0);
    assert.equal(info.lastUpdated, '2026-07-09 23:28:49.000');
    assert.match(info.modifiedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(info.activity, { code: 'act-1' });
  });

  it('falls back to the base resource when the hot-update overlay is missing', async () => {
    const base = await createTemporaryDirectory('la-pluma-resource-base-');
    const overlay = await createTemporaryDirectory('la-pluma-resource-overlay-');
    await writeFile(join(base, 'version.json'), metadataContent('2026-07-01 00:00:00.000'), 'utf-8');

    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [base, overlay],
      now: () => now
    });

    const info = await service.getResourceInfo();
    assert.equal(info.lastUpdated, '2026-07-01 00:00:00.000');
  });

  it('prefers the newest metadata across base and hot-update overlay', async () => {
    const base = await createTemporaryDirectory('la-pluma-resource-base-');
    const overlay = await createTemporaryDirectory('la-pluma-resource-overlay-');
    await writeFile(join(base, 'version.json'), metadataContent('2026-07-01 00:00:00.000'), 'utf-8');
    await writeFile(join(overlay, 'version.json'), metadataContent('2026-07-09 23:28:49.000'), 'utf-8');

    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [base, overlay],
      now: () => now
    });

    const info = await service.getResourceInfo();
    assert.equal(info.lastUpdated, '2026-07-09 23:28:49.000');
    assert.equal(info.status, 'current');
  });

  it('propagates unreadable version files instead of inventing a status', async () => {
    const resourceDir = await createTemporaryDirectory('la-pluma-resource-missing-');
    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [resourceDir]
    });

    await assert.rejects(
      service.getResourceInfo(),
      error => (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  });
});

describe('resource updates', () => {
  it('runs maa hot-update once and reports the refreshed resource info', async () => {
    const harness = createUpdateService({ resourceDirs: [baseDir, hotUpdateDir] });

    const result = await harness.service.updateResources();

    assert.deepEqual(harness.calls, ['hot-update']);
    assert.equal(harness.lease.request.source, 'resource-update');
    assert.equal(harness.lease.request.taskName, '同步 MAA 资源');
    assert.equal(harness.lease.request.command, 'hot-update');
    assert.equal(harness.lease.released, true);
    assert.equal(result.output, 'Hot update completed successfully\n');
    assert.equal(result.resource.status, 'current');
  });

  it('rejects a concurrent update immediately while one is in flight', { timeout: 5000 }, async () => {
    let resolveUpdate: (output: string) => void = () => {};
    const pending = new Promise<string>(resolve => { resolveUpdate = resolve; });
    const harness = createUpdateService({ hotUpdateResult: () => pending });

    const first = harness.service.updateResources();
    const rejected = harness.service.updateResources();
    assert.equal(harness.calls.length, 1);

    await assert.rejects(rejected, error => {
      const fields = error as { code?: string; statusCode?: number; retryable?: boolean; message?: string };
      assert.equal(fields.code, 'AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS');
      assert.equal(fields.statusCode, 409);
      assert.equal(fields.retryable, true);
      assert.match(fields.message ?? '', /已有资源更新正在进行/);
      return true;
    });
    assert.equal(harness.calls.length, 1, '并发请求不能启动第二次更新');

    resolveUpdate('ok\n');
    const firstResult = await first;
    assert.equal(firstResult.output, 'ok\n');
    assert.equal(harness.lease.released, true);

    const next = await harness.service.updateResources();
    assert.equal(harness.calls.length, 2, '首个结束后新请求可以重新开始');
    assert.equal(next.output, 'ok\n');
  });

  it('reports failures once without retrying and keeps the previous resource readable', async () => {
    let fail = true;
    const harness = createUpdateService({
      resourceDirs: [baseDir],
      hotUpdateError: () => fail ? new Error('git pull failed\n') : null
    });

    const first = harness.service.updateResources();
    const second = harness.service.updateResources();
    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);
    assert.equal(firstOutcome.status, 'rejected');
    assert.match(String((firstOutcome as PromiseRejectedResult).reason), /git pull failed/);
    assert.equal(secondOutcome.status, 'rejected');
    assert.equal(
      ((secondOutcome as PromiseRejectedResult).reason as { code?: string }).code,
      'AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS'
    );
    assert.equal(harness.calls.length, 1, '失败后不能自动重试');
    assert.equal(harness.lease.released, true);

    const info = await harness.service.getResourceInfo();
    assert.equal(info.lastUpdated, '2026-07-09 23:28:49.000');

    fail = false;
    const retry = await harness.service.updateResources();
    assert.equal(harness.calls.length, 2, '显式的新请求才启动新的更新');
    assert.equal(retry.resource.status, 'current');
  });

  it('refreshes metadata after the hot update', async () => {
    const harness = createUpdateService({ resourceDirs: [baseDir, hotUpdateDir] });
    harness.setVersion(hotUpdateDir, '2026-07-10 11:00:00.000');

    const result = await harness.service.updateResources();

    assert.equal(result.resource.lastUpdated, '2026-07-10 11:00:00.000');
    assert.equal(result.resource.ageDays, 0);
  });

  it('surfaces a busy lease without running or retrying the update', async () => {
    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [baseDir],
      readVersionFile: async () => ({ content: metadataContent('2026-07-09 23:28:49.000'), modifiedAt: now }),
      runHotUpdate: async () => {
        assert.fail('busy lease must not run the update');
      },
      withLease: async () => { throw new MaaExecutionBusyError(null); }
    });

    await assert.rejects(service.updateResources(), error => error instanceof MaaExecutionBusyError);
  });

  it('removes the in-flight update after a metadata refresh failure', async () => {
    let reads = 0;
    const calls: string[] = [];
    const service = createResourceUpdateService({
      resolveResourceDirs: async () => [baseDir],
      readVersionFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error('版本文件不可读');
        return { content: metadataContent('2026-07-09 23:28:49.000'), modifiedAt: now };
      },
      now: () => now,
      runHotUpdate: async () => {
        calls.push('hot-update');
        return 'ok\n';
      },
      withLease: async (_request, callback) => callback({
        owner: { pid: 1, source: 'test', taskName: null, command: null, startedAt: '' },
        lockPath: '/virtual/lock',
        reentrant: false,
        release: async () => {}
      })
    });

    await assert.rejects(service.updateResources(), /版本文件不可读/);
    const retry: ResourceUpdateResult = await service.updateResources();

    assert.equal(calls.length, 2);
    assert.equal(retry.resource.status, 'current');
  });
});
