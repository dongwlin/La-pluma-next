import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-update-channel-'));
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

const {
  readCliUpdateCapabilities,
  readUpdateChannels,
  saveUpdateChannel
} = await import('../updateChannelService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function writeCliConfig(content: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(cliConfigPath, content, 'utf-8');
}

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('update channel persistence', () => {
  beforeEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('defaults to stable when cli.toml is missing', async () => {
    assert.deepEqual(await readUpdateChannels(), { core: 'stable', cli: 'stable' });
    assert.deepEqual(await readCliUpdateCapabilities(), { binary: true });
  });

  it('reports degraded defaults when cli.toml is corrupted', async () => {
    await writeCliConfig('[core\nchannel = "Beta"\n');
    assert.deepEqual(await readUpdateChannels(), { core: 'stable', cli: 'stable', degraded: true });
    assert.deepEqual(await readCliUpdateCapabilities(), { binary: true, degraded: true });

    await writeCliConfig('core = "beta"\n');
    assert.deepEqual(await readUpdateChannels(), { core: 'stable', cli: 'stable', degraded: true });
  });

  it('reports degraded defaults when cli.toml cannot be read', async () => {
    await mkdir(cliConfigPath, { recursive: true });
    assert.deepEqual(await readUpdateChannels(), { core: 'stable', cli: 'stable', degraded: true });
    assert.deepEqual(await readCliUpdateCapabilities(), { binary: true, degraded: true });
  });

  it('reads canonical and aliased channel values', async () => {
    await writeCliConfig(`[core]
channel = "Beta"

[cli]
channel = "Alpha"
`);
    assert.deepEqual(await readUpdateChannels(), { core: 'beta', cli: 'nightly' });

    await writeCliConfig(`[core]
channel = "alpha"

[cli]
channel = "nightly"
`);
    assert.deepEqual(await readUpdateChannels(), { core: 'alpha', cli: 'nightly' });
  });

  it('persists a channel without dropping unrelated sections', async () => {
    await writeCliConfig(`github_proxy = "https://mirror.example"

[core]
channel = "Beta"
test_time = 0

[cli]
channel = "Nightly"

[cli.components]
binary = false

[resource]
auto_update = true
`);

    assert.deepEqual(await saveUpdateChannel('core', 'stable'), { core: 'stable', cli: 'nightly' });
    const content = await readFile(cliConfigPath, 'utf-8');
    assert.match(content, /github_proxy = "https:\/\/mirror\.example"/);
    assert.match(content, /channel = "Stable"/);
    assert.match(content, /test_time = 0/);
    assert.match(content, /channel = "Nightly"/);
    assert.match(content, /binary = false/);
    assert.match(content, /auto_update = true/);
    assert.deepEqual(await readCliUpdateCapabilities(), { binary: false });

    assert.deepEqual(await saveUpdateChannel('cli', 'beta'), { core: 'stable', cli: 'beta' });
    assert.match(await readFile(cliConfigPath, 'utf-8'), /channel = "Beta"/);
  });

  it('rejects unsupported channels before writing', async () => {
    await writeCliConfig('[core]\nchannel = "Beta"\n');
    await assert.rejects(saveUpdateChannel('core', 'nightly'), /核心更新渠道不合法/);
    await assert.rejects(saveUpdateChannel('cli', 'alpha'), /CLI 更新渠道不合法/);
    assert.match(await readFile(cliConfigPath, 'utf-8'), /channel = "Beta"/);
  });
});
