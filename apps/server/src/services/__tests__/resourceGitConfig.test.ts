import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-resource-config-'));
const cliPath = join(fixtureDir, 'maa.js');
const configDir = join(fixtureDir, 'config');
const baseResource = join(fixtureDir, 'resource');
const checkout = join(fixtureDir, 'MaaResource');
const marker = join(fixtureDir, 'updated');
const configFile = join(configDir, 'cli.toml');
const officialUrl = 'https://github.com/MaaAssistantArknights/MaaResource.git';
const execFileAsync = promisify(execFile);

process.env.MAA_CLI_PATH = cliPath;
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.HOME = fixtureDir;
process.env.XDG_CONFIG_HOME = fixtureDir;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(fixtureDir, 'gitconfig');

await mkdir(baseResource);
await writeFile(join(baseResource, 'version.json'), '{"last_updated":"2026-07-09 23:28:49.000"}');
await writeFile(cliPath, `#!${process.execPath}
const fs = require('node:fs');
const [command, name] = process.argv.slice(2);
if (command === 'dir') {
  const dirs = ${JSON.stringify({ config: configDir, resource: baseResource, 'hot-update': checkout })};
  if (name in dirs) fs.writeSync(1, dirs[name] + '\\n');
  else process.exitCode = 1;
} else if (command === 'convert' && process.argv[4] === '--format' && process.argv[5] === 'json') {
  fs.writeSync(1, fs.readFileSync(name));
} else if (command === 'hot-update') {
  fs.writeFileSync(${JSON.stringify(marker)}, 'updated');
} else {
  process.exitCode = 1;
}
`, { mode: 0o755 });

const { updateMaaResources } = await import('../resourceUpdateService.ts');

async function setCheckoutOrigin(origin: string): Promise<void> {
  await mkdir(checkout, { recursive: true });
  await execFileAsync('git', ['-C', checkout, 'init', '--quiet']);
  await execFileAsync('git', ['-C', checkout, 'remote', 'add', 'origin', origin]);
}

test.beforeEach(async () => {
  await Promise.all([
    rm(marker, { force: true }),
    rm(checkout, { recursive: true, force: true }),
    rm(configDir, { recursive: true, force: true })
  ]);
  await mkdir(configDir);
});

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('blocks an active legacy resource URL before updating and preserves the existing files', async () => {
  const content = '[resource.remote]\nurl = "git@example.invalid:private/resource.git"\n';
  await writeFile(configFile, content);

  await assert.rejects(updateMaaResources(), (error: Error) => {
    assert.ok(error.message.includes(configFile));
    assert.match(error.message, /resource\.remote\.url/);
    assert.doesNotMatch(error.message, /example\.invalid/);
    return true;
  });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(await readFile(configFile, 'utf8'), content);
});

test('checks the CLI-selected higher-priority configuration for active SSH settings', async () => {
  await writeFile(configFile, `[resource.source]\ntype = "git"\nurl = "${officialUrl}"\n`);
  const jsonPath = join(configDir, 'cli.json');
  await writeFile(jsonPath, JSON.stringify({ resource: { source: {
    type: 'git', backend: 'libgit2', ssh_key: 'private-key-location'
  } } }));

  await assert.rejects(updateMaaResources(), (error: Error) => {
    assert.ok(error.message.includes(jsonPath));
    assert.match(error.message, /resource\.source\.ssh_key/);
    assert.doesNotMatch(error.message, /private-key-location/);
    return true;
  });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('uses cli.yaml ahead of cli.yml and cli.toml when selecting the active config', async () => {
  await writeFile(configFile, '[resource]\nauto_update = false\n');
  await writeFile(join(configDir, 'cli.yml'), '{"resource":{"source":{"type":"mirrorchyan","cdk":false}}}');
  const yamlPath = join(configDir, 'cli.yaml');
  await writeFile(yamlPath, '{"resource":{"source":{"type":"git","use_ssh_agent":true}}}');

  await assert.rejects(updateMaaResources(), (error: Error) => {
    assert.ok(error.message.includes(yamlPath));
    assert.match(error.message, /resource\.source\.use_ssh_agent/);
    return true;
  });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('blocks an existing checkout with a non-official raw origin and preserves the checkout', async () => {
  await mkdir(join(checkout, 'resource'), { recursive: true });
  const versionFile = join(checkout, 'resource', 'version.json');
  const version = '{"last_updated":"2026-10-09 23:28:49.000"}';
  await writeFile(versionFile, version);
  await setCheckoutOrigin('https://mirror.example.invalid/resource.git');

  await assert.rejects(updateMaaResources(), (error: Error) => {
    assert.ok(error.message.includes(checkout));
    assert.match(error.message, /origin/);
    assert.doesNotMatch(error.message, /example\.invalid/);
    return true;
  });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(await readFile(versionFile, 'utf8'), version);
});

test('allows an existing checkout with the official origin and no custom settings', async () => {
  await setCheckoutOrigin(officialUrl);

  await updateMaaResources();
  assert.equal(await readFile(marker, 'utf8'), 'updated');
});

test('allows MirrorChyan when its selected configuration and idle checkout have old Git settings', async () => {
  await mkdir(checkout);
  await writeFile(configFile, '[resource.remote]\nurl = "git@example.invalid:private/resource.git"\n');
  await writeFile(join(configDir, 'cli.json'), JSON.stringify({ resource: { source: {
    type: 'mirrorchyan', cdk: false, url: 'https://mirror.example.invalid/resource.git', use_ssh_agent: true
  } } }));

  await updateMaaResources();
  assert.equal(await readFile(marker, 'utf8'), 'updated');
});
