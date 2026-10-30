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
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function callCount(): Promise<number> {
  const content = await readFile(callLog, 'utf-8').catch(() => '');
  return content.split('\n').filter(Boolean).length;
}

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('a failed config directory lookup is not cached', async () => {
  await writeFile(failMarker, '1', 'utf-8');
  await assert.rejects(getMaaConfigDir(), /命令执行失败/);

  await writeFile(failMarker, '1', 'utf-8');
  await assert.rejects(getMaaConfigDir(), /命令执行失败/);

  // 两次失败各调用一次 CLI：失败没有被缓存成结果。
  assert.equal(await callCount(), 2);
});

test('concurrent lookups share one CLI call and later lookups reuse the cached directory', async () => {
  const before = await callCount();

  const results = await Promise.all([
    getMaaConfigDir(),
    getMaaConfigDir(),
    getMaaConfigDir()
  ]);
  assert.deepEqual(results, [configDir, configDir, configDir]);
  assert.equal((await callCount()) - before, 1);

  assert.equal(await getMaaConfigDir(), configDir);
  assert.equal((await callCount()) - before, 1);
});
