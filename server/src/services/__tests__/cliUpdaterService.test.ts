import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildCliUpdaterPlan, resolveCliInstallSource } from '../cliUpdaterService.ts';

const standalone = '/usr/local/bin/maa';
const homebrewStable = '/opt/homebrew/Cellar/maa-cli/0.7.8/bin/maa';
const winget = '/home/user/AppData/Local/Microsoft/WinGet/Packages/MaaAssistantArknights.maa-cli/Maa/maa.exe';
const container = '/opt/maa-cli/bin/maa';

const resolveTo = (path: string | null) => async () => path;

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-cli-updater-'));

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function createExecutableFile(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(path, 0o755);
  return path;
}

describe('CLI updater selection', () => {
  it('selects self update for standalone binaries and passes the channel', async () => {
    const plan = await buildCliUpdaterPlan('beta', {
      cliPath: standalone,
      binaryEnabled: true,
      resolveExecutable: resolveTo(standalone)
    });
    assert.equal(plan.source, 'standalone');
    assert.equal(plan.supported, true);
    assert.equal(plan.command, standalone);
    assert.deepEqual(plan.args, ['self', 'update', 'beta']);

    const forced = await buildCliUpdaterPlan('stable', {
      cliPath: standalone,
      binaryEnabled: true,
      force: true,
      resolveExecutable: resolveTo(standalone)
    });
    assert.deepEqual(forced.args, ['self', 'update', 'stable', '--force']);
  });

  it('disables self update when the CLI binary component is disabled', async () => {
    const plan = await buildCliUpdaterPlan('stable', {
      cliPath: standalone,
      binaryEnabled: false,
      resolveExecutable: resolveTo(standalone)
    });
    assert.equal(plan.source, 'standalone');
    assert.equal(plan.supported, false);
    assert.match(plan.reason ?? '', /binary/);
  });

  it('uses Homebrew when the CLI was installed from a Homebrew cellar', async () => {
    assert.deepEqual(await resolveCliInstallSource({
      cliPath: 'maa',
      env: {},
      resolveExecutable: resolveTo(homebrewStable)
    }), { source: 'homebrew', path: homebrewStable });

    const stable = await buildCliUpdaterPlan('stable', {
      cliPath: 'maa',
      resolveExecutable: resolveTo(homebrewStable)
    });
    assert.deepEqual(stable.args, ['upgrade', 'maa-cli']);

    const beta = await buildCliUpdaterPlan('beta', {
      cliPath: 'maa',
      resolveExecutable: resolveTo(homebrewStable)
    });
    assert.deepEqual(beta.args, ['upgrade', 'maa-cli-beta']);

    const nightly = await buildCliUpdaterPlan('nightly', {
      cliPath: 'maa',
      resolveExecutable: resolveTo(homebrewStable)
    });
    assert.equal(nightly.supported, false);
    assert.match(nightly.reason ?? '', /Nightly/);
  });

  it('uses winget only for the stable channel', async () => {
    const stable = await buildCliUpdaterPlan('stable', {
      cliPath: 'maa',
      resolveExecutable: resolveTo(winget)
    });
    assert.equal(stable.source, 'winget');
    assert.deepEqual(stable.args, ['upgrade', 'maa-cli']);

    const beta = await buildCliUpdaterPlan('beta', {
      cliPath: 'maa',
      resolveExecutable: resolveTo(winget)
    });
    assert.equal(beta.supported, false);
    assert.match(beta.reason ?? '', /Stable/);
  });

  it('treats the image-managed binary as a container install and keeps self update', async () => {
    const source = await resolveCliInstallSource({
      cliPath: '/usr/local/bin/maa',
      env: { DOCKER_ENV: 'true' },
      resolveExecutable: resolveTo(container)
    });
    assert.deepEqual(source, { source: 'container', path: container });

    const plan = await buildCliUpdaterPlan('nightly', {
      cliPath: '/usr/local/bin/maa',
      env: { DOCKER_ENV: 'true' },
      resolveExecutable: resolveTo(container)
    });
    assert.equal(plan.source, 'container');
    assert.deepEqual(plan.args, ['self', 'update', 'nightly']);
  });

  it('reports a missing CLI instead of guessing a package manager', async () => {
    const plan = await buildCliUpdaterPlan('stable', {
      cliPath: standalone,
      resolveExecutable: resolveTo(null)
    });
    assert.equal(plan.supported, false);
    assert.match(plan.reason ?? '', /找不到/);
    assert.equal(plan.source, 'standalone');
  });
});

describe('CLI executable detection', () => {
  it('accepts an executable file', async () => {
    const executable = await createExecutableFile(join(fixtureDir, 'bin'), 'maa');

    assert.deepEqual(
      await resolveCliInstallSource({ cliPath: executable, env: {} }),
      { source: 'standalone', path: await realpath(executable) }
    );
  });

  it('rejects a directory even when its path exists', async () => {
    const directory = join(fixtureDir, 'not-a-binary');
    await mkdir(directory, { recursive: true });

    assert.equal(await resolveCliInstallSource({ cliPath: directory, env: {} }), null);
  });

  it('rejects a non-executable file', { skip: process.platform === 'win32' }, async () => {
    const plainFile = join(fixtureDir, 'plain-file');
    await writeFile(plainFile, 'maa\n', 'utf-8');
    await chmod(plainFile, 0o644);

    assert.equal(await resolveCliInstallSource({ cliPath: plainFile, env: {} }), null);
  });

  it('resolves an executable found on PATH', async () => {
    const binDir = join(fixtureDir, 'path-bin');
    const executable = await createExecutableFile(binDir, 'maa');

    assert.deepEqual(
      await resolveCliInstallSource({ cliPath: 'maa', env: { PATH: binDir } }),
      { source: 'standalone', path: await realpath(executable) }
    );
  });

  it('reports a directory on PATH as missing instead of an install source', async () => {
    const binDir = join(fixtureDir, 'path-dir-bin');
    await mkdir(join(binDir, 'maa'), { recursive: true });

    assert.equal(await resolveCliInstallSource({ cliPath: 'maa', env: { PATH: binDir } }), null);
  });
});
