import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
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

const { getRealtimeLogs, readLogFile, isPathOutsideDir, setTaskStatus, clearRealtimeLogs } = await import('../maaService.js');
const { loggerManager } = await import('../../utils/logger.ts');

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

describe('readLogFile path boundary', () => {
  const nestedDir = join(fakeLogDir, 'sub');
  const nestedLogFile = join(nestedDir, 'run-1.log');
  const outsideDir = join(fixtureDir, 'outside');
  const outsideLogFile = join(outsideDir, 'secret.log');

  before(async () => {
    await mkdir(nestedDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(nestedLogFile, 'nested log', 'utf-8');
    await writeFile(outsideLogFile, 'outside secret', 'utf-8');
    await writeFile(join(fakeLogDir, 'notes.txt'), 'not a log', 'utf-8');
    // 目录内符号链接：指向目录外的日志、悬空目标与目录内别名各一
    await symlink(outsideLogFile, join(fakeLogDir, 'escape.log'));
    await symlink(join(nestedDir, 'missing.log'), join(fakeLogDir, 'dangling.log'));
    await symlink(nestedLogFile, join(fakeLogDir, 'alias.log'));
    // 目录内目录符号链接指向目录外
    await symlink(outsideDir, join(fakeLogDir, 'sub-alias'));
  });

  it('reads nested files and internal symlink aliases inside the log directory', async () => {
    const nested = await readLogFile(nestedLogFile, 10);
    assert.equal(nested.totalLines, 1);
    assert.equal(nested.content, 'nested log');

    const alias = await readLogFile(join(fakeLogDir, 'alias.log'), 10);
    assert.equal(alias.content, 'nested log');
  });

  it('rejects traversal and absolute paths outside the log directory', async () => {
    const traversal = join(fakeLogDir, '..', 'outside', 'secret.log');
    await assert.rejects(readLogFile(traversal), /只能读取 MAA 日志目录内的文件/);
    await assert.rejects(readLogFile(outsideLogFile), /只能读取 MAA 日志目录内的文件/);
  });

  it('rejects symlinks resolving outside the log directory but not internal aliases', async () => {
    // realpath 后落到目录外：文件符号链接与目录符号链接都必须拒绝
    await assert.rejects(readLogFile(join(fakeLogDir, 'escape.log')), /只能读取 MAA 日志目录内的文件/);
    await assert.rejects(readLogFile(join(fakeLogDir, 'sub-alias', 'secret.log')), /只能读取 MAA 日志目录内的文件/);
    await assert.rejects(readLogFile(join(fakeLogDir, 'dangling.log')));
  });

  it('rejects non-log files, the log directory itself and missing files', async () => {
    await assert.rejects(readLogFile(join(fakeLogDir, 'notes.txt')), /只能读取 MAA 日志目录内的文件/);
    await assert.rejects(readLogFile(fakeLogDir), /只能读取 MAA 日志目录内的文件/);
    await assert.rejects(readLogFile(join(nestedDir, 'missing.log')));
  });
});

// Windows 路径策略通过注入 path.win32 验证；本仓库测试环境非 Windows，
// 无法在真实 Windows 运行时执行，这里覆盖的是同一份路径判定逻辑。
describe('isPathOutsideDir path policy', () => {
  it('posix policy contains descendants and rejects traversal, the dir itself and absolute escapes', () => {
    assert.equal(isPathOutsideDir('/data/logs', '/data/logs/asst.log', posix), false);
    assert.equal(isPathOutsideDir('/data/logs', '/data/logs/sub/run.log', posix), false);
    assert.equal(isPathOutsideDir('/data/logs', '/data/logs', posix), true);
    assert.equal(isPathOutsideDir('/data/logs', '/data/other/secret.log', posix), true);
    assert.equal(isPathOutsideDir('/data/logs', '/data/logs/..', posix), true);
  });

  it('win32 policy contains descendants and rejects drive-absolute, traversal and UNC escapes', () => {
    assert.equal(isPathOutsideDir('C:\\logs', 'C:\\logs\\asst.log', win32), false);
    assert.equal(isPathOutsideDir('C:\\logs', 'C:\\logs\\sub\\run.log', win32), false);
    assert.equal(isPathOutsideDir('C:\\logs', 'C:\\logs', win32), true);
    assert.equal(isPathOutsideDir('C:\\logs', 'C:\\Windows\\evil.log', win32), true);
    assert.equal(isPathOutsideDir('C:\\logs', 'C:\\logs\\..\\evil.log', win32), true);
    assert.equal(isPathOutsideDir('C:\\logs', '\\\\server\\share\\asst.log', win32), true);
  });
});
