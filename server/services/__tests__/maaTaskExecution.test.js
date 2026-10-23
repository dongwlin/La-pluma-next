import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'la-pluma-maa-execution-'));
const cliPath = join(root, 'maa');
const sharedCache = join(root, 'shared-cache');
const previousEnv = Object.fromEntries(
  ['MAA_CLI_PATH', 'MAA_CACHE_DIR', 'LA_PLUMA_MAA_LOCK_FILE'].map(key => [key, process.env[key]])
);
process.env.MAA_CLI_PATH = cliPath;
process.env.MAA_CACHE_DIR = sharedCache;
process.env.LA_PLUMA_MAA_LOCK_FILE = join(root, 'maa.lock');

await mkdir(sharedCache);
await writeFile(cliPath, `#!${process.execPath}
import { writeSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
const cacheDir = process.env.MAA_CACHE_DIR;
for (const file of ['StageActivityV2.json', 'resource/tasks/tasks.json', 'resource/global/YoStarEN/resource/tasks/tasks.json']) {
  JSON.parse(await readFile(join(cacheDir, file), 'utf-8'));
  const checked = await stat(join(cacheDir, file + '.etag'));
  if (Date.now() - checked.mtimeMs > 600_000) throw new Error('Network error');
}
const output = JSON.stringify({ args, cacheDir });
if (args.includes('--hold')) {
  const marker = args[args.indexOf('--hold') + 1];
  await writeFile(marker, output);
  for (let n = 0; n < 500; n++) {
    if (await stat(marker + '.release').then(() => true, () => false)) break;
    await delay(10);
  }
}
writeSync(1, output + '\\n');
if (args.includes('--fail')) {
  writeSync(2, 'MaaCore task failed\\n');
  process.exitCode = 7;
}
`, { mode: 0o755 });

const { execMaaCommand, getTaskStatus } = await import('../maaService.js');
const { loggerManager } = await import('../../utils/logger.js');
loggerManager.getLogger('MaaService').enableConsole = false;

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test('both foreground execution paths preserve fight options and clean private caches', async () => {
  const args = ['1-7', '-m', '0', '--expiring-medicine', '0', '--stone', '0', '--series', '0', '--report-to-penguin'];
  for (const taskName of [null, '理智作战']) {
    const result = await execMaaCommand('fight', args, taskName, 'combat', true);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['fight', ...args]);
    assert.notEqual(output.cacheDir, sharedCache);
    await assert.rejects(stat(output.cacheDir), { code: 'ENOENT' });
    assert.equal(getTaskStatus().isRunning, false);
  }
});

test('a failed fight remains failed and releases its private cache and execution lease', async () => {
  let failure;
  await assert.rejects(
    execMaaCommand('fight', ['1-7', '--fail'], '理智作战', 'combat', true),
    error => {
      failure = error;
      assert.equal(error.exitCode, 7);
      assert.match(error.stderr, /MaaCore task failed/);
      return true;
    }
  );
  await assert.rejects(stat(JSON.parse(failure.stdout).cacheDir), { code: 'ENOENT' });
  assert.equal(getTaskStatus().isRunning, false);
  await assert.rejects(stat(process.env.LA_PLUMA_MAA_LOCK_FILE), { code: 'ENOENT' });
});

test('a background fight retains its cache until the child has actually exited', async () => {
  const marker = join(root, 'background.json');
  let resolveOutcome;
  const settled = new Promise(resolve => { resolveOutcome = resolve; });
  const started = await execMaaCommand('fight', ['1-7', '--hold', marker], '理智作战', 'combat', false, false, {
    onSettled: resolveOutcome
  });
  assert.equal(started.message, '任务已在后台启动');

  let output;
  for (let n = 0; n < 100; n++) {
    output = await readFile(marker, 'utf-8').then(content => JSON.parse(content), () => null);
    if (output) break;
    await delay(10);
  }
  try {
    assert.ok(output, 'the background CLI should start');
    assert.ok((await stat(output.cacheDir)).isDirectory());
    assert.equal(getTaskStatus().isRunning, true);
  } finally {
    await writeFile(`${marker}.release`, '');
    await settled;
  }
  const outcome = await settled;
  assert.equal(outcome.ok, true);
  await assert.rejects(stat(output.cacheDir), { code: 'ENOENT' });
  await assert.rejects(stat(process.env.LA_PLUMA_MAA_LOCK_FILE), { code: 'ENOENT' });
  assert.equal(getTaskStatus().isRunning, false);
});
