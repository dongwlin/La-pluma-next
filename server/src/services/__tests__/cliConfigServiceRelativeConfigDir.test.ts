import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 独立的测试文件进程：`getMaaConfigDir` 成功结果按进程缓存，相对的配置目录输出
// 必须在本进程首次解析，不能与其它配置目录场景共享缓存。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-relative-config-dir-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');

await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CONFIG_DIR = 'maa-config';

const { readCliConfigDocument, resolveCliConfigPath } = await import('../cliConfigService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('rejects a relative config directory instead of resolving it against the process cwd', async () => {
  await assert.rejects(resolveCliConfigPath(), /绝对路径/);
  await assert.rejects(readCliConfigDocument(), /绝对路径/);
});
