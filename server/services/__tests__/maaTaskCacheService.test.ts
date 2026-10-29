import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareMaaTaskCache } from '../maaTaskCacheService.ts';
import type { MaaTaskCache } from '../maaTaskCacheService.ts';

test('local tasks reuse stale hot updates without changing the shared cache', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'la-pluma-cache-test-'));
  let taskCache: MaaTaskCache | null = null;
  try {
    const resourcePath = join(cacheDir, 'resource', 'tasks', 'tasks.json');
    const activityPath = join(cacheDir, 'StageActivityV2.json');
    await mkdir(dirname(resourcePath), { recursive: true });
    await writeFile(resourcePath, '{"FightBegin":{"postDelay":1000}}');
    await writeFile(`${resourcePath}.etag`, '"original-etag"');
    await writeFile(activityPath, '{"Official":{"sideStoryStage":{}}}');
    const oldDate = new Date('2020-01-01T00:00:00Z');
    await utimes(`${resourcePath}.etag`, oldDate, oldDate);

    const env: NodeJS.ProcessEnv = { MAA_CACHE_DIR: cacheDir, MAA_CONFIG_DIR: '/original/config', MAA_DATA_DIR: '/original/data' };
    taskCache = await prepareMaaTaskCache('fight', { env });
    assert.ok(taskCache);
    const cacheRoot = taskCache.env.MAA_CACHE_DIR;
    assert.ok(cacheRoot);
    const snapshotPath = join(cacheRoot, 'resource', 'tasks', 'tasks.json');

    assert.notEqual(taskCache.env.MAA_CACHE_DIR, cacheDir);
    assert.equal(taskCache.env.MAA_CONFIG_DIR, env.MAA_CONFIG_DIR);
    assert.equal(taskCache.env.MAA_DATA_DIR, env.MAA_DATA_DIR);
    assert.equal(env.MAA_CACHE_DIR, cacheDir);
    assert.equal(await readFile(snapshotPath, 'utf-8'), await readFile(resourcePath, 'utf-8'));
    assert.equal(await readFile(join(cacheRoot, 'StageActivityV2.json'), 'utf-8'), await readFile(activityPath, 'utf-8'));
    assert.ok(Date.now() - (await stat(`${snapshotPath}.etag`)).mtimeMs < 10_000);
    assert.equal(await readFile(`${resourcePath}.etag`, 'utf-8'), '"original-etag"');
    assert.equal((await stat(`${resourcePath}.etag`)).mtime.toISOString(), oldDate.toISOString());
  } finally {
    await taskCache?.cleanup();
    if (taskCache) {
      const cacheRoot = taskCache.env.MAA_CACHE_DIR;
      assert.ok(cacheRoot);
      await assert.rejects(stat(cacheRoot), { code: 'ENOENT' });
    }
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('missing or invalid optional overlays leave base resources usable for every client', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'la-pluma-cache-test-'));
  let taskCache: MaaTaskCache | null = null;
  try {
    await mkdir(join(cacheDir, 'resource', 'tasks'), { recursive: true });
    await writeFile(join(cacheDir, 'resource', 'tasks', 'tasks.json'), '{truncated');
    taskCache = await prepareMaaTaskCache('run', { env: { MAA_CACHE_DIR: cacheDir } });
    assert.ok(taskCache);
    const cacheRoot = taskCache.env.MAA_CACHE_DIR;
    assert.ok(cacheRoot);

    const files = ['StageActivityV2.json', ...[
      [], ['platform_diff', 'iOS', 'resource'],
      ...['YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy'].map(client => ['global', client, 'resource'])
    ].flatMap(target => [
      join('resource', ...target, 'tasks', 'tasks.json'),
      join('resource', ...target, 'tasks.json')
    ])];
    for (const file of files) {
      const destination = join(cacheRoot, file);
      assert.deepEqual(JSON.parse(await readFile(destination, 'utf-8')), {}, file);
      assert.ok((await stat(`${destination}.etag`)).isFile(), file);
    }
    assert.equal(await readFile(join(cacheDir, 'resource', 'tasks', 'tasks.json'), 'utf-8'), '{truncated');
  } finally {
    await taskCache?.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('update, discovery, and remote copilot commands retain normal network/cache behavior', async () => {
  for (const command of ['version', 'copilot']) {
    assert.equal(await prepareMaaTaskCache(command, { cliPath: '/missing/maa' }), null, command);
  }
});
