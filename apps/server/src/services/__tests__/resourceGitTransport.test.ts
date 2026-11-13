import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execMaaCommandUnlocked } from '../maaProcessService.ts';
import { prepareResourceGitEnvironment } from '../resourceGitTransport.ts';

const officialUrl = 'https://github.com/MaaAssistantArknights/MaaResource.git';
const installScript = fileURLToPath(new URL('../../../scripts/install-maa-core.ts', import.meta.url));
const execFileAsync = promisify(execFile);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-git-transport-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cliPath = join(dir, 'maa');
  const checkout = join(dir, 'MaaResource');
  const marker = join(dir, 'invoked');
  const gitConfig = join(dir, 'test.gitconfig');
  t.mock.method(process, 'cwd', () => dir);
  const envOverrides = {
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    MAA_CONFIG_DIR: dir,
    MAA_CACHE_DIR: join(dir, 'cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  await writeFile(cliPath, `#!${process.execPath}
const fs = require('node:fs');
const [command, name] = process.argv.slice(2);
if (command === 'dir') {
  fs.writeSync(1, name === 'hot-update' ? ${JSON.stringify(checkout)} : ${JSON.stringify(dir)});
} else {
  fs.appendFileSync(${JSON.stringify(marker)}, command + ':' + (process.env.GIT_ALLOW_PROTOCOL ?? '') + '\\n');
}
`, { mode: 0o755 });

  return {
    cliPath, dir, checkout, marker,
    git: (...args: string[]) => execFileSync('git', args, { cwd: dir }),
    config: (contents: string) => writeFile(join(dir, 'cli.toml'), contents),
    run: (command: string) => execMaaCommandUnlocked(command, [], null, null, false, true, null, {}, { cliPath })
  };
}

test('blocks an effective URL rewrite before manual sync, Core maintenance, or task auto-update', async t => {
  const f = await fixture(t);
  await f.config('[resource]\nauto_update = true\n');
  f.git('config', '--global', '--add', 'url.ssh://git@elsewhere.invalid/.insteadOf', 'https://github.com/');

  for (const command of ['hot-update', 'install', 'update', 'run']) {
    await assert.rejects(f.run(command), /insteadOf/);
  }
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('checks checkout-local rewriting with the libgit2 backend', async t => {
  const f = await fixture(t);
  await mkdir(f.checkout);
  f.git('-C', f.checkout, 'init', '--quiet');
  f.git('-C', f.checkout, 'remote', 'add', 'origin', officialUrl);
  f.git('-C', f.checkout, 'config', '--add', 'url.https://elsewhere.invalid/resources.insteadOf', officialUrl);
  await f.config('[resource.source]\ntype = "git"\nbackend = "libgit2"\n');

  await assert.rejects(f.run('hot-update'), /insteadOf/);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('checks libgit2 defaults even if system Git overrides its global config path', async t => {
  const f = await fixture(t);
  await f.config('[resource.source]\ntype = "git"\nbackend = "libgit2"\n');
  await writeFile(join(f.dir, '.gitconfig'), '[url "https://elsewhere.invalid/"]\n\tinsteadOf = https://github.com/\n');

  await assert.rejects(f.run('hot-update'), /insteadOf/);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('checks conditional Git config for a first clone before the checkout exists', async t => {
  const f = await fixture(t);
  const included = join(f.dir, 'resource.gitconfig');
  f.git('config', '--global', '--add', `includeIf.gitdir:${f.checkout}/.git.path`, included);
  f.git('config', '--file', included, '--add', 'url.https://elsewhere.invalid/.insteadOf', 'https://github.com/');

  await assert.rejects(f.run('hot-update'), /resource\.gitconfig.*insteadOf/);
  await assert.rejects(access(f.checkout), { code: 'ENOENT' });
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('blocks a Git config origin override even on a first clone', async t => {
  const f = await fixture(t);
  f.git('config', '--global', 'remote.origin.url', 'https://elsewhere.invalid/resources');

  await assert.rejects(f.run('hot-update'), /remote\.origin\.url/);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('keeps system Git from introducing a rewrite through a clone template', async t => {
  const f = await fixture(t);
  const template = join(f.dir, 'template');
  const localRepo = join(f.dir, 'local.git');
  await mkdir(template);
  f.git('init', '--quiet', '--bare', localRepo);
  f.git('config', '--global', 'init.templateDir', template);
  f.git('config', '--file', join(template, 'config'), `url.${localRepo}.insteadOf`, officialUrl);

  const env = await prepareResourceGitEnvironment('hot-update', f.cliPath, process.env, f.dir);
  await assert.rejects(execFileAsync('git', ['clone', officialUrl, f.checkout], {
    cwd: f.dir,
    env: { ...env, GIT_ALLOW_PROTOCOL: 'file', LC_ALL: 'C' }
  }), /transport 'https' not allowed/);
  await assert.rejects(access(f.checkout), { code: 'ENOENT' });
});

test('stops before the upstream fallback when system Git cannot verify the repository', async t => {
  const f = await fixture(t);
  const previous = process.env.PATH;
  process.env.PATH = f.dir;
  t.after(() => { process.env.PATH = previous; });

  await assert.rejects(f.run('hot-update'), /安装系统 Git/);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('container first install uses the same policy before launching maa install', async t => {
  const f = await fixture(t);
  const install = () => execFileAsync(process.execPath, [installScript], {
    cwd: f.dir,
    env: { ...process.env, MAA_CLI_PATH: f.cliPath }
  });
  f.git('config', '--global', '--add', 'url.ssh://git@elsewhere.invalid/.insteadOf', officialUrl);

  await assert.rejects(install(), /insteadOf/);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });

  f.git('config', '--global', '--unset-all', 'url.ssh://git@elsewhere.invalid/.insteadOf');
  await install();
  assert.equal(await readFile(f.marker, 'utf8'), 'install:https\n');
});

test('limits the Git child to HTTPS while leaving inactive Git settings out of the check', async t => {
  const f = await fixture(t);
  await f.run('hot-update');
  f.git('config', '--global', '--add', 'url.ssh://git@elsewhere.invalid/.insteadOf', 'https://github.com/');
  await f.run('run');
  await f.config('[resource.source]\ntype = "mirrorchyan"\ncdk = false\n');
  await f.run('hot-update');
  assert.equal(await readFile(f.marker, 'utf8'), 'hot-update:https\nrun:\nhot-update:\n');
});
