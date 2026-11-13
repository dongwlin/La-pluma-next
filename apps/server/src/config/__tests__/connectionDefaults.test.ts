import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resolveConnectionDefaults } from '../runtimeConfig.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(testDir, 'fixtures', 'printConnectionDefaults.ts');

interface FixtureOutput {
  imported: Record<string, string>;
  afterImportMutation: Record<string, string>;
  resolvedEmpty: Record<string, string>;
}

/** 以显式环境运行 fixture，避免父进程环境渗入默认值断言。 */
function runFixture(overrides: Record<string, string>): FixtureOutput {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['ADB_PATH', 'ADB_ADDRESS', 'MAA_CLIENT_TYPE', 'MAA_CLI_PATH', 'DOCKER_ENV']) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [fixturePath], {
    env: { ...env, ...overrides },
    encoding: 'utf-8'
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as FixtureOutput;
}

const PLATFORM_ADB_FALLBACKS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/opt/homebrew/bin/adb',
  linux: '/usr/bin/adb',
  win32: 'adb.exe'
};

const fallbacks = {
  adbPath: PLATFORM_ADB_FALLBACKS[process.platform] ?? '/usr/bin/adb',
  adbAddress: '127.0.0.1:16384',
  clientType: 'Official',
  maaCliPath: 'maa'
};

describe('resolveConnectionDefaults', () => {
  it('falls back to the existing defaults for a missing or empty environment', () => {
    assert.deepEqual(resolveConnectionDefaults({}), fallbacks);
    assert.deepEqual(resolveConnectionDefaults({
      ADB_PATH: '',
      ADB_ADDRESS: '',
      MAA_CLIENT_TYPE: '',
      MAA_CLI_PATH: ''
    }), fallbacks);
  });

  it('uses the platform ADB default and the container path under DOCKER_ENV', () => {
    assert.equal(resolveConnectionDefaults({}, { platform: 'darwin' }).adbPath, '/opt/homebrew/bin/adb');
    assert.equal(resolveConnectionDefaults({}, { platform: 'linux' }).adbPath, '/usr/bin/adb');
    assert.equal(resolveConnectionDefaults({}, { platform: 'win32' }).adbPath, 'adb.exe');
    assert.equal(
      resolveConnectionDefaults({ DOCKER_ENV: '1' }, { platform: 'darwin' }).adbPath,
      '/usr/bin/adb'
    );
    assert.equal(
      resolveConnectionDefaults({ DOCKER_ENV: '1', ADB_PATH: '/custom/adb' }, { platform: 'linux' }).adbPath,
      '/custom/adb'
    );
  });

  it('honors the documented connection variables', () => {
    assert.deepEqual(resolveConnectionDefaults({
      ADB_PATH: '/custom/adb',
      ADB_ADDRESS: '192.168.1.5:5555',
      MAA_CLIENT_TYPE: 'Bilibili'
    }), {
      adbPath: '/custom/adb',
      adbAddress: '192.168.1.5:5555',
      clientType: 'Bilibili',
      maaCliPath: 'maa'
    });
  });

  it('uses the container CLI path for a non-empty DOCKER_ENV unless MAA_CLI_PATH is set', () => {
    assert.equal(resolveConnectionDefaults({ DOCKER_ENV: '1' }).maaCliPath, '/usr/local/bin/maa');
    assert.equal(resolveConnectionDefaults({ DOCKER_ENV: '', MAA_CLI_PATH: '/custom/maa' }).maaCliPath, '/custom/maa');
    assert.equal(resolveConnectionDefaults({ DOCKER_ENV: '1', MAA_CLI_PATH: '/custom/maa' }).maaCliPath, '/custom/maa');
  });

  it('reads the process environment once at import and keeps injected resolution independent', () => {
    const output = runFixture({
      ADB_PATH: '/fixture/adb',
      ADB_ADDRESS: '10.0.0.9:5555',
      MAA_CLIENT_TYPE: 'YoStarEN',
      MAA_CLI_PATH: '/fixture/maa'
    });

    const expected = {
      adbPath: '/fixture/adb',
      adbAddress: '10.0.0.9:5555',
      clientType: 'YoStarEN',
      maaCliPath: '/fixture/maa'
    };
    assert.deepEqual(output.imported, expected);
    assert.deepEqual(output.afterImportMutation, expected, '导入后修改环境不能改变具名常量');
    assert.deepEqual(output.resolvedEmpty, fallbacks, '显式空环境仍按缺省值解析');
  });

  it('resolves the container CLI default at import when DOCKER_ENV is set', () => {
    const output = runFixture({ DOCKER_ENV: '1' });

    assert.equal(output.imported.maaCliPath, '/usr/local/bin/maa');
    assert.equal(output.resolvedEmpty.maaCliPath, 'maa');
  });
});
