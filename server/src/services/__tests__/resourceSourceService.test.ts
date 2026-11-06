import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import TOML from '@iarna/toml';

// MAA_CLI_PATH 在模块导入时读取；先准备只回答 `dir config` 的假 CLI，
// 让 cli.toml 读写全部落在临时目录。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-resource-source-'));
const configDir = join(fixtureDir, 'maa-config');
const cliConfigPath = join(configDir, 'cli.toml');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');

await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CONFIG_DIR = configDir;

const { readResourceSourceConfig, saveResourceSourceConfig } = await import('../resourceSourceService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function writeCliConfig(content: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(cliConfigPath, content, 'utf-8');
}

async function readCliToml(): Promise<Record<string, unknown>> {
  return TOML.parse(await readFile(cliConfigPath, 'utf-8')) as Record<string, unknown>;
}

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const gitInput = {
  backend: 'git' as const,
  url: 'https://git.example.com/MaaResource.git',
  branch: 'main',
  useSshAgent: false,
  sshKey: null
};

describe('resource source configuration', () => {
  beforeEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('falls back to the official Git source when cli.toml is missing', async () => {
    assert.deepEqual(await readResourceSourceConfig(), {
      autoUpdate: false,
      warnOnUpdateFailure: false,
      source: 'git',
      git: {
        backend: 'git',
        url: 'https://github.com/MaaAssistantArknights/MaaResource.git',
        branch: null,
        useSshAgent: false,
        sshKey: null,
        passphraseKind: 'none'
      },
      mirrorchyan: { cdkKind: 'none', checkInterval: 600 }
    });
  });

  it('reads a Git source and secret forms', async () => {
    await writeCliConfig(`[resource]
auto_update = true
warn_on_update_failure = true

[resource.source]
type = "git"
backend = "libgit2"
url = "git@example.org:custom/resources.git"
branch = "custom"
use_ssh_agent = true
ssh_key = "~/.ssh/id_ed25519"
passphrase = { env = "MAA_GIT_PASSPHRASE" }
`);

    assert.deepEqual(await readResourceSourceConfig(), {
      autoUpdate: true,
      warnOnUpdateFailure: true,
      source: 'git',
      git: {
        backend: 'libgit2',
        url: 'git@example.org:custom/resources.git',
        branch: 'custom',
        useSshAgent: true,
        sshKey: '~/.ssh/id_ed25519',
        passphraseKind: 'env'
      },
      mirrorchyan: { cdkKind: 'none', checkInterval: 600 }
    });
  });

  it('reads MirrorChyan sources and treats cdk = false as unconfigured', async () => {
    await writeCliConfig(`[resource.source]
type = "mirrorchyan"
cdk = "secret"
check_interval = 0
`);

    const configured = await readResourceSourceConfig();
    assert.equal(configured.source, 'mirrorchyan');
    assert.deepEqual(configured.mirrorchyan, { cdkKind: 'plain', checkInterval: 0 });

    await writeCliConfig(`[resource.source]
type = "mirrorchyan"
cdk = false
`);

    const empty = await readResourceSourceConfig();
    assert.deepEqual(empty.mirrorchyan, { cdkKind: 'none', checkInterval: 600 });
  });

  it('reads the legacy backend and remote layout', async () => {
    await writeCliConfig(`[resource]
backend = "libgit2"
auto_update = true

[resource.remote]
url = "https://mirror.example.com/Resource.git"
branch = "mirror"
`);

    const config = await readResourceSourceConfig();
    assert.equal(config.source, 'git');
    assert.equal(config.autoUpdate, true);
    assert.equal(config.git.backend, 'libgit2');
    assert.equal(config.git.url, 'https://mirror.example.com/Resource.git');
    assert.equal(config.git.branch, 'mirror');
  });

  it('writes the new source section and preserves unrelated cli.toml sections', async () => {
    await writeCliConfig(`github_proxy = "https://proxy.example.com"

[core]
channel = "Beta"

[resource]
auto_update = false

[resource.remote]
url = "https://legacy.example.com/Resource.git"
branch = "legacy"
`);

    const saved = await saveResourceSourceConfig({
      autoUpdate: true,
      warnOnUpdateFailure: true,
      source: 'git',
      git: {
        backend: 'libgit2',
        url: 'https://git.example.com/MaaResource.git',
        branch: 'main',
        useSshAgent: true,
        sshKey: '~/.ssh/id_ed25519'
      },
      mirrorchyan: { checkInterval: 600 }
    });

    const parsed = await readCliToml();
    assert.equal(parsed.github_proxy, 'https://proxy.example.com');
    assert.deepEqual(parsed.core, { channel: 'Beta' });
    const resource = parsed.resource as Record<string, unknown>;
    assert.equal(resource.auto_update, true);
    assert.equal(resource.warn_on_update_failure, true);
    assert.equal(resource.backend, undefined);
    assert.equal(resource.remote, undefined);
    assert.deepEqual(resource.source, {
      type: 'git',
      backend: 'libgit2',
      url: 'https://git.example.com/MaaResource.git',
      branch: 'main',
      use_ssh_agent: true,
      ssh_key: '~/.ssh/id_ed25519'
    });
    assert.equal(saved.source, 'git');
    assert.equal(saved.git.passphraseKind, 'none');
  });

  it('preserves a stored CDK when the request leaves it blank', async () => {
    await writeCliConfig(`[resource.source]
type = "mirrorchyan"
cdk = { cmd = ["pass", "show", "mirrorchyan"] }
check_interval = 1200
`);

    await saveResourceSourceConfig({
      autoUpdate: false,
      warnOnUpdateFailure: true,
      source: 'mirrorchyan',
      git: gitInput,
      mirrorchyan: { checkInterval: 600 }
    });

    const parsed = await readCliToml();
    const resource = parsed.resource as Record<string, unknown>;
    assert.deepEqual(resource.source, {
      type: 'mirrorchyan',
      cdk: { cmd: ['pass', 'show', 'mirrorchyan'] }
    });
    const reread = await readResourceSourceConfig();
    assert.equal(reread.mirrorchyan.cdkKind, 'command');
    assert.equal(reread.mirrorchyan.checkInterval, 600);
  });

  it('replaces and clears the CDK explicitly', async () => {
    await writeCliConfig(`[resource.source]
type = "mirrorchyan"
cdk = "old"
`);

    await saveResourceSourceConfig({
      autoUpdate: false,
      warnOnUpdateFailure: false,
      source: 'mirrorchyan',
      git: gitInput,
      mirrorchyan: { checkInterval: 600, cdk: 'new-secret' }
    });
    assert.equal(
      ((await readCliToml()).resource as Record<string, unknown>).source !== null,
      true
    );
    let source = ((await readCliToml()).resource as Record<string, unknown>).source as Record<string, unknown>;
    assert.equal(source.cdk, 'new-secret');

    await saveResourceSourceConfig({
      autoUpdate: false,
      warnOnUpdateFailure: false,
      source: 'mirrorchyan',
      git: gitInput,
      mirrorchyan: { checkInterval: 600, clearCdk: true }
    });
    source = ((await readCliToml()).resource as Record<string, unknown>).source as Record<string, unknown>;
    assert.equal(source.cdk, false);
    assert.equal((await readResourceSourceConfig()).mirrorchyan.cdkKind, 'none');
  });

  it('keeps unknown keys inside the managed source table', async () => {
    await writeCliConfig(`[resource.source]
type = "git"
url = "https://git.example.com/Resource.git"
future_option = "kept"
`);

    await saveResourceSourceConfig({
      autoUpdate: false,
      warnOnUpdateFailure: false,
      source: 'git',
      git: { ...gitInput, url: 'https://git.example.com/Resource.git', branch: 'main' },
      mirrorchyan: { checkInterval: 600 }
    });

    const source = ((await readCliToml()).resource as Record<string, unknown>).source as Record<string, unknown>;
    assert.equal(source.future_option, 'kept');
    assert.equal(source.branch, 'main');
    assert.equal(source.url, 'https://git.example.com/Resource.git');
  });

  it('rejects invalid source values without rewriting cli.toml', async () => {
    const original = `[resource]
auto_update = true
`;
    await writeCliConfig(original);

    const invalidInputs: unknown[] = [
      null,
      { source: 'ftp' },
      { autoUpdate: 'yes', warnOnUpdateFailure: false, source: 'git', git: gitInput, mirrorchyan: { checkInterval: 600 } },
      { autoUpdate: false, warnOnUpdateFailure: false, source: 'git', git: { ...gitInput, backend: 'hg' }, mirrorchyan: { checkInterval: 600 } },
      { autoUpdate: false, warnOnUpdateFailure: false, source: 'git', git: gitInput, mirrorchyan: { checkInterval: -1 } }
    ];
    for (const input of invalidInputs) {
      await assert.rejects(
        saveResourceSourceConfig(input),
        (error: unknown) => {
          const validationError = error as { code?: unknown; statusCode?: unknown };
          assert.equal(validationError.code, 'AGENT_RESOURCE_SOURCE_INVALID');
          assert.equal(validationError.statusCode, 400);
          return true;
        }
      );
    }
    assert.equal(await readFile(cliConfigPath, 'utf-8'), original);
  });

  it('fails explicitly on corrupted cli.toml', async () => {
    const corrupted = '[resource\nauto_update = ';
    await writeCliConfig(corrupted);

    await assert.rejects(readResourceSourceConfig());
    await assert.rejects(
      saveResourceSourceConfig({
        autoUpdate: false,
        warnOnUpdateFailure: false,
        source: 'git',
        git: gitInput,
        mirrorchyan: { checkInterval: 600 }
      })
    );
    assert.equal(await readFile(cliConfigPath, 'utf-8'), corrupted);
  });
});
