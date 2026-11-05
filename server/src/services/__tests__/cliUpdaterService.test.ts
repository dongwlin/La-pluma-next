import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCliUpdaterPlan, resolveCliInstallSource } from '../cliUpdaterService.ts';

const standalone = '/usr/local/bin/maa';
const homebrewStable = '/opt/homebrew/Cellar/maa-cli/0.7.8/bin/maa';
const homebrewBeta = '/opt/homebrew/Cellar/maa-cli-beta/0.8.0/bin/maa';
const winget = '/home/user/AppData/Local/Microsoft/WinGet/Packages/MaaAssistantArknights.maa-cli/Maa/maa.exe';
const container = '/opt/maa-cli/bin/maa';

const resolveTo = (path: string | null) => async () => path;

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
      resolveExecutable: resolveTo(homebrewBeta)
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
