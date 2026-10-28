import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCopilotProgressStore } from '../copilotProgressStore.js';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-progress-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('store factory requires a non-empty progress path', () => {
  assert.throws(() => createCopilotProgressStore({}), TypeError);
  assert.throws(() => createCopilotProgressStore({ progressPath: '' }), TypeError);
});

test('missing progress file loads as empty and updates create it atomically', async () => {
  await withTempDir(async dir => {
    const store = createCopilotProgressStore({ progressPath: join(dir, 'copilot-progress.json') });
    assert.deepEqual(await store.load(), {});
    assert.deepEqual(await readdir(dir), []);

    await store.update(current => ({ ...current, '42': ['0:10:normal'] }));

    assert.deepEqual(await store.load(), { '42': ['0:10:normal'] });
    // 原子替换：目录里只有目标文件，没有残留临时文件。
    assert.deepEqual(await readdir(dir), ['copilot-progress.json']);
  });
});

test('concurrent updates to different keys do not lose either update', async () => {
  await withTempDir(async dir => {
    const store = createCopilotProgressStore({ progressPath: join(dir, 'copilot-progress.json') });
    await store.update(() => ({ existing: true }));

    await Promise.all([
      store.update(async current => {
        await new Promise(resolve => setTimeout(resolve, 6));
        return { ...current, '42': ['0:10:normal'] };
      }),
      store.update(async current => {
        await new Promise(resolve => setTimeout(resolve, 3));
        return { ...current, '43': ['1:11:raid'] };
      })
    ]);

    assert.deepEqual(await store.load(), { existing: true, '42': ['0:10:normal'], '43': ['1:11:raid'] });
  });
});

test('concurrent update and reset of different keys keep both effects', async () => {
  await withTempDir(async dir => {
    const store = createCopilotProgressStore({ progressPath: join(dir, 'copilot-progress.json') });
    await store.update(() => ({ '42': ['a'], '43': ['b'] }));

    await Promise.all([
      store.update(current => ({ ...current, '42': ['a', 'a2'] })),
      store.update(current => {
        const next = { ...current };
        delete next['43'];
        return next;
      })
    ]);

    assert.deepEqual(await store.load(), { '42': ['a', 'a2'] });
  });
});

test('a corrupted progress file is reported instead of silently reset', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'copilot-progress.json');
    const broken = '{"42": ["0:10:normal"';
    await writeFile(filePath, broken, 'utf8');
    const store = createCopilotProgressStore({ progressPath: filePath });

    await assert.rejects(store.load(), /读取 JSON 文件失败/);
    await assert.rejects(store.update(current => ({ ...current, '43': ['x'] })), /读取 JSON 文件失败/);
    // 损坏文件保持原样：失败的读改写不会把已有进度清零。
    assert.equal(await readFile(filePath, 'utf8'), broken);
  });
});

test('a progress path under a regular file fails identifiably on read and update', async () => {
  await withTempDir(async dir => {
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, '{}', 'utf8');
    const store = createCopilotProgressStore({ progressPath: join(blocker, 'copilot-progress.json') });

    await assert.rejects(store.load(), /读取 JSON 文件失败/);
    await assert.rejects(store.update(() => ({})), /读取 JSON 文件失败/);
  });
});

test('a failing write is reported and leaves the previous content intact', async t => {
  // chmod 对 root 无效；root 环境跳过该只读目录场景。
  if (process.getuid?.() === 0) {
    t.skip('需要非 root 用户验证只读目录导致的写失败');
    return;
  }
  await withTempDir(async dir => {
    const store = createCopilotProgressStore({ progressPath: join(dir, 'copilot-progress.json') });
    await store.update(() => ({ keep: true }));

    await chmod(dir, 0o500);
    try {
      await assert.rejects(store.update(() => ({ replaced: true })));
      assert.deepEqual(await store.load(), { keep: true });
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

test('progress written by previous versions stays readable and round-trips', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'copilot-progress.json');
    // 旧实现以 JSON.stringify(progress, null, 2) 整份直写，形状为 {作业集: [条目键]}。
    const legacy = { '42': ['0:10:normal'], '43': ['1:11:raid'] };
    await writeFile(filePath, JSON.stringify(legacy, null, 2), 'utf8');
    const store = createCopilotProgressStore({ progressPath: filePath });

    assert.deepEqual(await store.load(), legacy);

    await store.update(current => ({ ...current, '42': [...current['42'], '0:10:raid'] }));

    const after = await store.load();
    assert.deepEqual(after['42'], ['0:10:normal', '0:10:raid']);
    assert.deepEqual(after['43'], ['1:11:raid']);
    // 写回仍是可读的 pretty JSON，与旧文件可读性一致。
    assert.match(await readFile(filePath, 'utf8'), /^\{\n/);
  });
});
