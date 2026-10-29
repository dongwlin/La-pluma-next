import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJsonFile, updateJsonFile, updateTextFile, writeJsonFile, writeTextFile } from '../fileHelper.ts';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-file-'));
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

test('writeTextFile atomically replaces the target and removes its temp file', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'profile.toml');
    await writeTextFile(filePath, 'profile_name = "daily"\n');
    await writeTextFile(filePath, 'profile_name = "weekly"\n');

    assert.equal(await readFile(filePath, 'utf8'), 'profile_name = "weekly"\n');
    assert.deepEqual(await readdir(dir), ['profile.toml']);
  });
});

test('writeTextFile keeps the permission bits of an existing target', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'profile.toml');
    await writeTextFile(filePath, 'profile_name = "daily"\n');
    await chmod(filePath, 0o640);

    await writeTextFile(filePath, 'profile_name = "weekly"\n');

    assert.equal((await stat(filePath)).mode & 0o777, 0o640);
  });
});

test('a write failure rejects and leaves no temp file behind', async () => {
  await withTempDir(async dir => {
    const targetPath = join(dir, 'profile.toml');
    // 目标被目录占用：临时文件写入成功，但最终替换失败。
    await mkdir(targetPath);

    await assert.rejects(
      writeTextFile(targetPath, 'profile_name = "daily"\n'),
      /写入文本文件失败/
    );

    assert.deepEqual(await readdir(dir), ['profile.toml']);
  });
});

test('writeTextFile refuses to replace a read-only target', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'profile.toml');
    await writeTextFile(filePath, 'profile_name = "daily"\n');
    await chmod(filePath, 0o444);

    try {
      await assert.rejects(
        writeTextFile(filePath, 'profile_name = "weekly"\n'),
        /写入文本文件失败/
      );
      assert.equal(await readFile(filePath, 'utf8'), 'profile_name = "daily"\n');
    } finally {
      await chmod(filePath, 0o644);
    }

    assert.deepEqual(await readdir(dir), ['profile.toml']);
  });
});

test('concurrent updates to the same text path are serialized', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'notes.txt');
    await writeTextFile(filePath, '');

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      updateTextFile(filePath, async current => {
        assert.equal(typeof current, 'string');
        await new Promise(resolve => setTimeout(resolve, 1));
        return `${current}line-${index}\n`;
      })
    ));

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 20);
    assert.deepEqual(
      [...lines].sort(),
      Array.from({ length: 20 }, (_, index) => `line-${index}`).sort()
    );
  });
});

test('updates to different text paths do not share one queue', async () => {
  await withTempDir(async dir => {
    const firstPath = join(dir, 'daily.toml');
    const secondPath = join(dir, 'weekly.toml');

    // first 的回调停在门上；second 必须能在 first 结束前独立完成，
    // 证明两条路径各自排队而不是共享一条全局队列。
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = updateTextFile(firstPath, async () => {
      await gate;
      return 'profile_name = "daily"\n';
    });

    const second = updateTextFile(secondPath, async () => 'profile_name = "weekly"\n');
    // 共享队列时 second 只能排在被门挡住的 first 之后；用超时把这种情形转成明确失败，
    // 而不是依赖两个文件的 I/O 完成顺序。finally 里放行门并清理计时器，
    // 保证失败路径上 first 也能收尾，测试进程不会悬挂。
    let cancelSharedQueueTimeout: () => void = () => {};
    const sharedQueueTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('不同路径的更新被同一队列串行化')), 2000);
      cancelSharedQueueTimeout = () => clearTimeout(timer);
    });
    try {
      await Promise.race([second, sharedQueueTimeout]);
    } finally {
      cancelSharedQueueTimeout();
      releaseFirst();
    }

    await first;

    assert.equal(await readFile(firstPath, 'utf8'), 'profile_name = "daily"\n');
    assert.equal(await readFile(secondPath, 'utf8'), 'profile_name = "weekly"\n');
  });
});

test('a failed text update keeps the previous content', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'profile.toml');
    await writeTextFile(filePath, 'profile_name = "daily"\n');

    await assert.rejects(
      updateTextFile(filePath, () => {
        throw new Error('解析失败');
      }),
      /解析失败/
    );

    assert.equal(await readFile(filePath, 'utf8'), 'profile_name = "daily"\n');
    assert.deepEqual(await readdir(dir), ['profile.toml']);
  });
});
