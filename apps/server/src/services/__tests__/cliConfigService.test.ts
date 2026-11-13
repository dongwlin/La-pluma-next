import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// MAA_CLI_PATH 与假 CLI 的输出在模块导入时读取：`maa dir config` 返回绝对配置目录。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-cli-config-'));
const configDir = join(fixtureDir, 'maa-config');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const cliConfigPath = join(configDir, 'cli.toml');

await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CONFIG_DIR = configDir;

const { readCliConfigDocument, resolveCliConfigPath } = await import('../cliConfigService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('cli config path resolution', () => {
  it('resolves cli.toml under the absolute MAA config directory', async () => {
    assert.equal(await resolveCliConfigPath(), cliConfigPath);
  });

  it('reads the parsed cli.toml document', async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(cliConfigPath, '[core]\nchannel = "beta"\n', 'utf-8');

    assert.deepEqual(await readCliConfigDocument(), { core: { channel: 'beta' } });
  });

  it('falls back to an empty document when cli.toml is missing', async () => {
    await rm(cliConfigPath, { force: true });

    assert.deepEqual(await readCliConfigDocument(), {});
  });

  it('rejects invalid TOML instead of treating it as an empty document', async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(cliConfigPath, '[core\nchannel = "beta"\n', 'utf-8');

    await assert.rejects(readCliConfigDocument());
  });
});
