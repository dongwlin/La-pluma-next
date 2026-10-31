import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// MAA_CLI_PATH 在模块导入时读取；假 CLI 记录每次 `dir config` 调用，并用
// marker 制造一次性失败，验证缓存共享、成功复用与失败重试。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maa-config-dir-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const configDir = join(fixtureDir, 'maa-config');
const callLog = join(fixtureDir, 'dir-config-calls.log');
const failMarker = join(fixtureDir, 'fail-once');

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'dir' || args[1] !== 'config') process.exit(1);
fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, 'dir config\\n');
if (fs.existsSync(process.env.FAKE_MAA_FAIL_MARKER)) {
  fs.unlinkSync(process.env.FAKE_MAA_FAIL_MARKER);
  process.exit(1);
}
process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CALL_LOG = callLog;
process.env.FAKE_MAA_CONFIG_DIR = configDir;
process.env.FAKE_MAA_FAIL_MARKER = failMarker;

const { getMaaConfigDir } = await import('../maaConfigService.ts');
const { clearRealtimeLogs, getRealtimeLogs } = await import('../maaProcessService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function callCount(): Promise<number> {
  const content = await readFile(callLog, 'utf-8').catch(() => '');
  return content.split('\n').filter(Boolean).length;
}

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('a failed config directory lookup is cached briefly and then retried', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  clearRealtimeLogs();
  await writeFile(failMarker, '1', 'utf-8');
  await assert.rejects(getMaaConfigDir(), /命令执行失败/);

  // 目录查询是诊断类短命令：失败重试不应持续写“执行命令”日志。
  assert.ok(!getRealtimeLogs(100).some(entry => entry.message.includes('执行命令')));

  // 冷却期内不重新启动 CLI，直接复用同一个失败结果。
  await assert.rejects(getMaaConfigDir(), /命令执行失败/);
  assert.equal(await callCount(), 1);

  t.mock.timers.tick(30_001);

  const results = await Promise.all([
    getMaaConfigDir(),
    getMaaConfigDir(),
    getMaaConfigDir()
  ]);
  assert.deepEqual(results, [configDir, configDir, configDir]);
  assert.equal(await callCount(), 2);

  // 成功结果继续按进程缓存。
  assert.equal(await getMaaConfigDir(), configDir);
  assert.equal(await callCount(), 2);
});
