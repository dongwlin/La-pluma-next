import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-log-dir-failure-'));
const logDir = join(fixtureDir, 'maa-logs');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const callLog = join(fixtureDir, 'dir-log-calls.log');
const readyMarker = join(fixtureDir, 'ready');

await mkdir(logDir, { recursive: true });
await writeFile(join(logDir, 'asst.log'), 'line\n', 'utf-8');
await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(callLog)}, 'dir log\\n');
if (!fs.existsSync(${JSON.stringify(readyMarker)})) process.exit(1);
process.stdout.write(${JSON.stringify(logDir)});
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_LOG_DIR = logDir;

const { getLogFiles, readLogFile } = await import('../maaLogFileService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function callCount(): Promise<number> {
  const content = await readFile(callLog, 'utf-8').catch(() => '');
  return content.split('\n').filter(Boolean).length;
}

test('caches log directory lookup failures for a cooldown and then retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  assert.deepEqual(await getLogFiles(), []);
  await assert.rejects(readLogFile(join(logDir, 'asst.log')), /获取日志目录失败/);
  assert.equal(await callCount(), 1);

  t.mock.timers.tick(30_001);
  await writeFile(readyMarker, '1');

  const files = await getLogFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'asst.log');
  assert.equal(await callCount(), 2);
});

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});
