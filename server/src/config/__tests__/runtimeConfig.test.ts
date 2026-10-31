import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  loadHttpsOptions,
  normalizeBasePath,
  parseBooleanSwitch,
  parsePort,
  parsePositiveInteger,
  resolveAppPaths,
  RuntimeConfigError
} from '../runtimeConfig.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(testDir, '..', '..', '..');
const fixturePath = join(testDir, 'fixtures', 'printResolvedPaths.ts');

describe('parsePort', () => {
  it('falls back on missing or blank values', () => {
    const options = { fallback: 3000, name: 'PORT' };
    assert.equal(parsePort(undefined, options), 3000);
    assert.equal(parsePort('', options), 3000);
    assert.equal(parsePort('   ', options), 3000);
  });

  it('accepts integers in the 0-65535 range and keeps the 0 semantics', () => {
    const options = { fallback: 3000, name: 'PORT' };
    assert.equal(parsePort('0', options), 0);
    assert.equal(parsePort('8443', options), 8443);
    assert.equal(parsePort('65535', options), 65535);
  });

  it('rejects non-integers, out-of-range and non-numeric values with the variable name', () => {
    for (const raw of ['-1', '65536', '3000.5', 'abc', 'NaN', 'Infinity', '12,000']) {
      assert.throws(
        () => parsePort(raw, { fallback: 3000, name: 'PORT' }),
        (error: unknown) => error instanceof RuntimeConfigError
          && error.variableName === 'PORT'
          && error.code === 'RUNTIME_CONFIG_INVALID'
          && error.message.includes('PORT'),
        `expected PORT=${raw} to be rejected`
      );
    }
  });
});

describe('parsePositiveInteger', () => {
  it('falls back on missing or blank values', () => {
    const options = { fallback: 5000, name: 'LA_PLUMA_MAX_REALTIME_LOGS' };
    assert.equal(parsePositiveInteger(undefined, options), 5000);
    assert.equal(parsePositiveInteger('', options), 5000);
  });

  it('accepts positive integers', () => {
    const options = { fallback: 5000, name: 'LA_PLUMA_MAX_REALTIME_LOGS' };
    assert.equal(parsePositiveInteger('1', options), 1);
    assert.equal(parsePositiveInteger(' 5000 ', options), 5000);
  });

  it('rejects zero, negatives, decimals and non-numeric values', () => {
    for (const raw of ['0', '-3', '2.5', 'abc']) {
      assert.throws(
        () => parsePositiveInteger(raw, { fallback: 5000, name: 'LA_PLUMA_MAX_REALTIME_LOGS' }),
        RuntimeConfigError,
        `expected LA_PLUMA_MAX_REALTIME_LOGS=${raw} to be rejected`
      );
    }
  });
});

describe('parseBooleanSwitch', () => {
  it('falls back on missing or blank values', () => {
    const options = { fallback: false, name: 'LA_PLUMA_SWITCH' };
    assert.equal(parseBooleanSwitch(undefined, options), false);
    assert.equal(parseBooleanSwitch('', options), false);
    assert.equal(parseBooleanSwitch(' ', options), false);
  });

  it('accepts true and false spellings case-insensitively', () => {
    const options = { fallback: false, name: 'LA_PLUMA_SWITCH' };
    for (const raw of ['1', 'true', 'YES', 'On', ' true ']) {
      assert.equal(parseBooleanSwitch(raw, options), true, `expected ${raw} to be true`);
    }
    for (const raw of ['0', 'false', 'NO', 'Off', ' false ']) {
      assert.equal(parseBooleanSwitch(raw, options), false, `expected ${raw} to be false`);
    }
  });

  it('rejects unknown spellings with the variable name', () => {
    assert.throws(
      () => parseBooleanSwitch('maybe', { fallback: false, name: 'LA_PLUMA_SWITCH' }),
      (error: unknown) => error instanceof RuntimeConfigError
        && error.variableName === 'LA_PLUMA_SWITCH'
        && error.code === 'RUNTIME_CONFIG_INVALID'
    );
  });
});

describe('resolveAppPaths', () => {
  it('anchors all application paths to the module location, not the cwd', () => {
    const paths = resolveAppPaths({ env: {} });

    assert.equal(paths.serverRoot, serverRoot);
    assert.equal(paths.appDataDir, join(serverRoot, 'data'));
    assert.equal(paths.agentRunStorePath, join(serverRoot, 'data', 'agent-runs.json'));
    assert.equal(paths.userConfigsDir, join(serverRoot, 'data', 'user-configs'));
    assert.equal(paths.dropRecordsDir, join(serverRoot, 'data', 'drop-records'));
    assert.equal(paths.executionLockPath, join(serverRoot, 'data', 'maa-execution.lock'));
    assert.equal(paths.trainingDataDir, join(serverRoot, 'data'));
    assert.equal(paths.frontendDistDir, resolve(serverRoot, '..', 'client', 'dist'));
    assert.equal(paths.tempResourceDir, join(serverRoot, '.temp-maa-resource'));
  });

  it('anchors the default server root at the server package directory, not src/', () => {
    const paths = resolveAppPaths({ env: {} });

    // 包目录名是布局契约（workspace 声明 packages: client/server）：
    // 默认锚点必须停在 server/，否则运行数据会静默写入 server/src/data。
    assert.equal(basename(paths.serverRoot), 'server');
    // 源码树位于 <serverRoot>/src 之下；锚点既不能少算也不能多算一层。
    assert.equal(resolve(paths.serverRoot, 'src', 'config', '__tests__'), testDir);
    assert.equal(paths.appDataDir, join(paths.serverRoot, 'data'));
    assert.equal(basename(dirname(paths.appDataDir)), 'server');
  });

  it('names reference and training data files inside the training data directory', () => {
    const paths = resolveAppPaths({ env: {} });

    assert.equal(paths.materialsPath, join(paths.trainingDataDir, 'materials.json'));
    assert.equal(paths.materialFormulasPath, join(paths.trainingDataDir, 'material-formulas.json'));
    assert.equal(paths.operatorMaterialsPath, join(paths.trainingDataDir, 'operator-materials.json'));
    assert.equal(paths.operatorQuotesPath, join(paths.appDataDir, 'operatorQuotes.json'));
    assert.equal(paths.penguinDropDataPath, join(paths.trainingDataDir, 'penguin-drop-data.json'));
    assert.equal(paths.depotPath, join(paths.trainingDataDir, 'depot.json'));
    assert.equal(paths.operboxPath, join(paths.trainingDataDir, 'operbox.json'));
  });

  it('honors the existing LA_PLUMA_* override variables and empty-value fallbacks', () => {
    const paths = resolveAppPaths({
      env: {
        LA_PLUMA_AGENT_RUN_STORE: '/custom/agent-runs.json',
        LA_PLUMA_DROP_RECORDS_DIR: '/custom/drop-records',
        LA_PLUMA_MAA_LOCK_FILE: '/custom/maa.lock',
        LA_PLUMA_TRAINING_DATA_DIR: '/custom/training'
      }
    });

    assert.equal(paths.agentRunStorePath, '/custom/agent-runs.json');
    assert.equal(paths.dropRecordsDir, '/custom/drop-records');
    assert.equal(paths.executionLockPath, '/custom/maa.lock');
    assert.equal(paths.trainingDataDir, '/custom/training');
    assert.equal(paths.materialsPath, '/custom/training/materials.json');
    assert.equal(paths.operatorMaterialsPath, '/custom/training/operator-materials.json');
    assert.equal(paths.penguinDropDataPath, '/custom/training/penguin-drop-data.json');
    assert.equal(paths.depotPath, '/custom/training/depot.json');
    assert.equal(paths.operboxPath, '/custom/training/operbox.json');
    // 其余类别不受影响
    assert.equal(paths.userConfigsDir, join(paths.appDataDir, 'user-configs'));
    assert.equal(paths.operatorQuotesPath, join(paths.appDataDir, 'operatorQuotes.json'));

    const emptyOverrides = resolveAppPaths({
      env: {
        LA_PLUMA_AGENT_RUN_STORE: '',
        LA_PLUMA_DROP_RECORDS_DIR: '',
        LA_PLUMA_MAA_LOCK_FILE: '',
        LA_PLUMA_TRAINING_DATA_DIR: ''
      }
    });
    const defaults = resolveAppPaths({ env: {} });
    assert.equal(emptyOverrides.agentRunStorePath, defaults.agentRunStorePath);
    assert.equal(emptyOverrides.dropRecordsDir, defaults.dropRecordsDir);
    assert.equal(emptyOverrides.executionLockPath, defaults.executionLockPath);
    assert.equal(emptyOverrides.trainingDataDir, defaults.trainingDataDir);
  });

  it('supports an injected server root for sandboxed fixtures', () => {
    const paths = resolveAppPaths({ env: {}, serverRoot: '/tmp/la-pluma-sandbox/server' });

    assert.equal(paths.serverRoot, '/tmp/la-pluma-sandbox/server');
    assert.equal(paths.appDataDir, '/tmp/la-pluma-sandbox/server/data');
    assert.equal(paths.frontendDistDir, '/tmp/la-pluma-sandbox/client/dist');
  });
});

describe('normalizeBasePath', () => {
  it('keeps the assembly entry normalization contract', () => {
    assert.equal(normalizeBasePath(), '/');
    assert.equal(normalizeBasePath(undefined), '/');
    assert.equal(normalizeBasePath(''), '/');
    assert.equal(normalizeBasePath('/'), '/');
    assert.equal(normalizeBasePath('la-pluma'), '/la-pluma/');
    assert.equal(normalizeBasePath('/la-pluma/'), '/la-pluma/');
  });
});

describe('loadHttpsOptions', () => {
  it('returns null when neither path is configured and requires both when one is set', () => {
    assert.equal(loadHttpsOptions({}), null);
    assert.throws(
      () => loadHttpsOptions({ LA_PLUMA_HTTPS_CERT_PATH: '/cert.pem' }),
      /必须同时配置/
    );
  });

  it('reads both files through the injected reader', () => {
    const reads: string[] = [];
    const options = loadHttpsOptions({
      LA_PLUMA_HTTPS_CERT_PATH: '/cert.pem',
      LA_PLUMA_HTTPS_KEY_PATH: '/key.pem'
    }, path => {
      reads.push(path);
      return Buffer.from(path);
    });

    assert.deepEqual(reads, ['/cert.pem', '/key.pem']);
    assert.equal(options?.cert.toString(), '/cert.pem');
    assert.equal(options?.key.toString(), '/key.pem');
  });
});

describe('cwd independence and import purity', () => {
  const childEnv = { ...process.env, LA_PLUMA_AGENT_RUN_STORE: '/fixture/should-not-apply.json' };

  function runFixture(cwd: string) {
    return spawnSync(process.execPath, [fixturePath], { cwd, encoding: 'utf8', env: childEnv });
  }

  it('resolves identical paths when the entry is loaded from different working directories', () => {
    const fromTmp = runFixture(tmpdir());
    const fromServerRoot = runFixture(serverRoot);
    const fromParent = runFixture(resolve(serverRoot, '..'));

    assert.equal(fromTmp.status, 0, fromTmp.stderr);
    assert.equal(fromServerRoot.status, 0, fromServerRoot.stderr);
    assert.equal(fromParent.status, 0, fromParent.stderr);

    const fromTmpResult = JSON.parse(fromTmp.stdout);
    const fromServerRootResult = JSON.parse(fromServerRoot.stdout);
    const fromParentResult = JSON.parse(fromParent.stdout);

    assert.deepEqual(fromTmpResult, fromServerRootResult);
    assert.deepEqual(fromTmpResult, fromParentResult);

    // 与进程内解析一致，证明路径锚定模块位置而非启动目录
    const inProcess = resolveAppPaths({ env: {} });
    assert.equal(fromTmpResult.serverRoot, inProcess.serverRoot);
    assert.equal(fromTmpResult.appDataDir, inProcess.appDataDir);
    assert.equal(fromTmpResult.frontendDistDir, inProcess.frontendDistDir);
    assert.equal(fromTmpResult.tempResourceDir, inProcess.tempResourceDir);
  });

  it('does not freeze process env at import time', () => {
    // 子进程环境带有 LA_PLUMA_AGENT_RUN_STORE，但 fixture 显式传空环境；
    // 若模块在导入时固化了 process.env，这里会得到 /fixture/should-not-apply.json
    const fromTmp = runFixture(tmpdir());
    assert.equal(fromTmp.status, 0, fromTmp.stderr);

    const result = JSON.parse(fromTmp.stdout);
    assert.equal(result.agentRunStorePath, join(serverRoot, 'data', 'agent-runs.json'));
    assert.equal(result.dropRecordsDir, join(serverRoot, 'data', 'drop-records'));
    assert.equal(result.executionLockPath, join(serverRoot, 'data', 'maa-execution.lock'));
    assert.equal(result.trainingDataDir, join(serverRoot, 'data'));
    // 注入的 MAA 平台参数独立于真实运行平台
    assert.equal(result.maaConfigDir, '/fixture-home/.config/maa');
  });
});
