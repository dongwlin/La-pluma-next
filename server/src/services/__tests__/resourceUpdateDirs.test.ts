import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// `maa dir hot-update` 失败时不能用空覆盖层静默降级：只有成功的空输出才表示没有覆盖层。
// 假 CLI 在子进程里按 env/marker 切换输出，导前设置 MAA_CLI_PATH。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-resource-dirs-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const resourceDir = join(fixtureDir, 'maa-resource');
const hotUpdateDir = join(fixtureDir, 'maa-hot-update');
const failMarker = join(fixtureDir, 'fail-hot-update');

await mkdir(resourceDir, { recursive: true });
await writeFile(join(resourceDir, 'version.json'), JSON.stringify({
  last_updated: '2026-07-09 23:28:49.000'
}), 'utf-8');

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'dir' && args[1] === 'resource') {
  process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'hot-update') {
  if (fs.existsSync(process.env.FAKE_MAA_HOT_UPDATE_FAIL_MARKER)) {
    process.stderr.write('unknown directory type: hot-update\\n');
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_MAA_HOT_UPDATE_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
process.env.FAKE_MAA_HOT_UPDATE_DIR = hotUpdateDir;
process.env.FAKE_MAA_HOT_UPDATE_FAIL_MARKER = failMarker;

const { getMaaResourceDirs, getMaaResourceInfo } = await import('../resourceUpdateService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('includes the hot-update overlay when the CLI resolves its directory', async () => {
  assert.deepEqual(await getMaaResourceDirs(), [resourceDir, join(hotUpdateDir, 'resource')]);
});

test('treats an empty hot-update directory as no overlay', async () => {
  const previous = process.env.FAKE_MAA_HOT_UPDATE_DIR;
  process.env.FAKE_MAA_HOT_UPDATE_DIR = '';
  try {
    assert.deepEqual(await getMaaResourceDirs(), [resourceDir]);
  } finally {
    process.env.FAKE_MAA_HOT_UPDATE_DIR = previous;
  }
});

test('rejects resource info instead of silently dropping a failing directory lookup', async () => {
  await writeFile(failMarker, '1', 'utf-8');
  try {
    await assert.rejects(getMaaResourceDirs(), /命令执行失败/);
    await assert.rejects(getMaaResourceInfo(), /命令执行失败/);
  } finally {
    await rm(failMarker, { force: true });
  }
});
