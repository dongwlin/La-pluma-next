import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 调试产物属于 MAA stateDir；Linux 下由 XDG_STATE_HOME 决定。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-debug-screenshots-'));
const stateHome = join(fixtureDir, 'state');
const debugDir = join(stateHome, 'maa', 'debug');
await mkdir(debugDir, { recursive: true });
await writeFile(join(debugDir, 'shot.png'), Buffer.from('png'));
await writeFile(join(debugDir, 'note.txt'), 'not an image');

process.env.XDG_STATE_HOME = stateHome;

const { getDebugScreenshots } = await import('../maaLogFileService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

test('reads debug screenshots from the MAA state directory without absolute paths', {
  skip: process.platform !== 'linux'
}, async () => {
  const screenshots = await getDebugScreenshots();
  assert.equal(screenshots.length, 1);
  assert.equal(screenshots[0].name, 'shot.png');
  assert.equal(screenshots[0].path, 'shot.png');
  assert.ok(!screenshots[0].path.includes(fixtureDir));
  assert.equal(screenshots[0].size, 3);
});

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});
