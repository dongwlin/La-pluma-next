import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';

// MAA_CLI_PATH 在模块导入时读取；先准备好假 CLI 和临时日志目录再导入被测模块。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-log-bounds-'));
const fakeLogDir = join(fixtureDir, 'maa-logs');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'log') {
  // 不显式 exit：stdout 为管道时立即 exit 可能截断输出
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_LOG_DIR = fakeLogDir;

const { getRealtimeLogs, readLogFile, setTaskStatus, clearRealtimeLogs } = await import('../maaService.js');
const { loggerManager } = await import('../../utils/logger.js');

loggerManager.getLogger('MaaService').enableConsole = false;

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const SEED_LOG_COUNT = 510;

function seedRealtimeLogs(count = SEED_LOG_COUNT) {
  for (let i = 0; i < count; i++) {
    setTaskStatus(i % 2 === 0, `seed-task-${i}`, 'automation');
  }
  setTaskStatus(false);
}

describe('getRealtimeLogs numeric bounds', () => {
  beforeEach(() => {
    clearRealtimeLogs();
  });

  afterEach(() => {
    clearRealtimeLogs();
    setTaskStatus(false);
  });

  it('returns the default count for omitted, invalid and repeated input', () => {
    seedRealtimeLogs();
    assert.equal(getRealtimeLogs().length, 100);
    assert.equal(getRealtimeLogs('abc').length, 100);
    assert.equal(getRealtimeLogs(Number.NaN).length, 100);
    assert.equal(getRealtimeLogs(['1', '2']).length, 100);
  });

  it('falls back to the default for non-finite magnitudes and clamps oversized finite values', () => {
    seedRealtimeLogs();
    assert.equal(getRealtimeLogs(Infinity).length, 100);
    assert.equal(getRealtimeLogs('1e999').length, 100);
    assert.equal(getRealtimeLogs('1e9').length, 500);
    assert.equal(getRealtimeLogs(1000).length, 500);
  });

  it('clamps negatives and zero to one line and truncates decimals', () => {
    seedRealtimeLogs();
    assert.equal(getRealtimeLogs(-5).length, 1);
    assert.equal(getRealtimeLogs(0).length, 1);
    assert.equal(getRealtimeLogs(3.9).length, 3);
  });

  it('keeps valid in-range requests untouched', () => {
    seedRealtimeLogs();
    assert.equal(getRealtimeLogs(80).length, 80);
    assert.equal(getRealtimeLogs(200).length, 200);
  });
});

describe('readLogFile numeric bounds', () => {
  const totalLines = 6000;
  let logFilePath;

  before(async () => {
    await mkdir(fakeLogDir, { recursive: true });
    logFilePath = join(fakeLogDir, 'asst.log');
    const lines = [];
    for (let i = 1; i <= totalLines; i++) lines.push(`log line ${i}`);
    await writeFile(logFilePath, lines.join('\n'), 'utf-8');
  });

  it('returns the default count for omitted, invalid and repeated input', async () => {
    for (const lines of [undefined, 'abc', Number.NaN, ['1', '2']]) {
      const result = await readLogFile(logFilePath, lines);
      assert.equal(result.totalLines, totalLines);
      assert.equal(result.returnedLines, 1000);
      assert.equal(result.content.split('\n').length, 1000);
      assert.ok(result.content.endsWith(`log line ${totalLines}`));
    }
  });

  it('falls back to the default for non-finite magnitudes and clamps oversized finite values', async () => {
    assert.equal((await readLogFile(logFilePath, Infinity)).returnedLines, 1000);
    const oversized = await readLogFile(logFilePath, '1e21');
    assert.equal(oversized.returnedLines, 5000);
    assert.equal((await readLogFile(logFilePath, 6000)).returnedLines, 5000);
    assert.equal((await readLogFile(logFilePath, '1e9')).returnedLines, 5000);
    assert.ok(oversized.content.endsWith(`log line ${totalLines}`));
  });

  it('clamps negatives and zero to one line and truncates decimals', async () => {
    assert.equal((await readLogFile(logFilePath, -5)).returnedLines, 1);
    assert.equal((await readLogFile(logFilePath, 0)).returnedLines, 1);
    const decimal = await readLogFile(logFilePath, 3.9);
    assert.equal(decimal.returnedLines, 3);
    assert.ok(decimal.content.endsWith(`log line ${totalLines}`));
  });

  it('keeps valid in-range requests untouched', async () => {
    const result = await readLogFile(logFilePath, 200);
    assert.equal(result.returnedLines, 200);
    assert.ok(result.content.endsWith(`log line ${totalLines}`));
  });
});
