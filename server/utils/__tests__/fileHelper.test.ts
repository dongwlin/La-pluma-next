import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJsonFile, updateJsonFile, writeJsonFile } from '../fileHelper.ts';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-json-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writeJsonFile atomically replaces the target and removes its temp file', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'config.json');
    await writeJsonFile(filePath, { enabled: true, count: 2 });

    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { enabled: true, count: 2 });
    assert.deepEqual(await readdir(dir), ['config.json']);
  });
});

test('a failed JSON serialization leaves the previous file intact', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'config.json');
    await writeJsonFile(filePath, { version: 1 });

    await assert.rejects(
      writeJsonFile(filePath, { unsupported: 1n }),
      /写入 JSON 文件失败/
    );

    assert.deepEqual(await readJsonFile(filePath), { version: 1 });
    assert.deepEqual(await readdir(dir), ['config.json']);
  });
});

test('concurrent updates to the same JSON path are serialized', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'counter.json');
    await writeJsonFile(filePath, { count: 0 });

    await Promise.all(Array.from({ length: 20 }, () =>
      updateJsonFile(filePath, async current => {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (typeof current !== 'object' || current === null || !('count' in current) || typeof current.count !== 'number') {
          throw new TypeError(`意外的计数载荷: ${JSON.stringify(current)}`);
        }
        return { count: current.count + 1 };
      })
    ));

    assert.deepEqual(await readJsonFile(filePath), { count: 20 });
  });
});
