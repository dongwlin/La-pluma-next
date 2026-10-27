import assert from 'node:assert/strict';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  getBattleDataPath,
  getItemIndexPath,
  getItemTablePath,
  getMaaLogPath,
  getMaaResourceDir,
  printPathConfig,
  resolveMaaPaths
} from '../paths.ts';

describe('resolveMaaPaths cross-platform resolution', () => {
  it('resolves Linux paths from the home directory with XDG defaults', () => {
    const paths = resolveMaaPaths({ env: {}, platform: 'linux', homedir: '/home/fixture' });

    assert.equal(paths.configDir, '/home/fixture/.config/maa');
    assert.equal(paths.dataDir, '/home/fixture/.local/share/maa');
    assert.equal(paths.stateDir, '/home/fixture/.local/state/maa');
    assert.equal(paths.resourceDir, '/home/fixture/.local/share/maa/resource');
    assert.equal(paths.logPath, '/home/fixture/.local/state/maa/debug/asst.log');
    assert.equal(paths.itemIndexPath, '/home/fixture/.local/share/maa/resource/item_index.json');
    assert.equal(
      paths.itemTablePath,
      '/home/fixture/.local/share/maa/resource/gamedata/excel/item_table.json'
    );
    assert.equal(paths.battleDataPath, '/home/fixture/.local/share/maa/resource/battle_data.json');
  });

  it('honors XDG override variables on Linux', () => {
    const paths = resolveMaaPaths({
      env: {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state'
      },
      platform: 'linux',
      homedir: '/home/fixture'
    });

    assert.equal(paths.configDir, '/xdg/config/maa');
    assert.equal(paths.dataDir, '/xdg/data/maa');
    assert.equal(paths.stateDir, '/xdg/state/maa');
  });

  it('falls back to home-relative defaults when XDG values are missing or empty', () => {
    const missing = resolveMaaPaths({ env: {}, platform: 'linux', homedir: '/home/fixture' });
    const empty = resolveMaaPaths({
      env: { XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '' },
      platform: 'linux',
      homedir: '/home/fixture'
    });

    assert.equal(missing.configDir, empty.configDir);
    assert.equal(missing.dataDir, empty.dataDir);
    assert.equal(missing.stateDir, empty.stateDir);
  });

  it('resolves macOS paths under Application Support', () => {
    const paths = resolveMaaPaths({ env: {}, platform: 'darwin', homedir: '/Users/fixture' });

    assert.equal(paths.configDir, '/Users/fixture/Library/Application Support/com.loong.maa');
    assert.equal(paths.dataDir, '/Users/fixture/Library/Application Support/com.loong.maa');
    assert.equal(paths.stateDir, '/Users/fixture/Library/Application Support/com.loong.maa');
    assert.equal(
      paths.logPath,
      '/Users/fixture/Library/Application Support/com.loong.maa/debug/asst.log'
    );
  });

  it('resolves Windows paths from APPDATA and LOCALAPPDATA with home fallbacks', () => {
    const home = 'C:\\Users\\fixture';
    const overridden = resolveMaaPaths({
      env: { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') },
      platform: 'win32',
      homedir: home
    });

    assert.equal(overridden.configDir, join(join(home, 'AppData', 'Roaming'), 'maa'));
    assert.equal(overridden.dataDir, join(join(home, 'AppData', 'Local'), 'maa'));
    assert.equal(overridden.stateDir, join(join(home, 'AppData', 'Local'), 'maa'));

    const fallback = resolveMaaPaths({ env: {}, platform: 'win32', homedir: home });

    assert.equal(fallback.configDir, join(join(home, 'AppData', 'Roaming'), 'maa'));
    assert.equal(fallback.dataDir, join(join(home, 'AppData', 'Local'), 'maa'));
    assert.equal(fallback.stateDir, join(join(home, 'AppData', 'Local'), 'maa'));
  });

  it('falls back to Linux-style paths on unknown platforms', () => {
    const paths = resolveMaaPaths({ env: {}, platform: 'freebsd', homedir: '/home/fixture' });

    assert.equal(paths.configDir, '/home/fixture/.config/maa');
    assert.equal(paths.dataDir, '/home/fixture/.local/share/maa');
    assert.equal(paths.stateDir, '/home/fixture/.local/state/maa');
  });

  it('keeps calls independent: injected env does not leak between calls', () => {
    const overridden = resolveMaaPaths({
      env: { XDG_CONFIG_HOME: '/xdg/one' },
      platform: 'linux',
      homedir: '/home/fixture'
    });
    const clean = resolveMaaPaths({ env: {}, platform: 'linux', homedir: '/home/fixture' });

    assert.equal(overridden.configDir, '/xdg/one/maa');
    assert.equal(clean.configDir, '/home/fixture/.config/maa');
  });
});

describe('legacy path getters', () => {
  it('delegates to resolveMaaPaths with the current process environment', () => {
    const current = resolveMaaPaths();

    assert.equal(getMaaLogPath(), current.logPath);
    assert.equal(getMaaResourceDir(), current.resourceDir);
    assert.equal(getItemIndexPath(), current.itemIndexPath);
    assert.equal(getItemTablePath(), current.itemTablePath);
    assert.equal(getBattleDataPath(), current.battleDataPath);
  });

  it('composes derived paths from the platform directories', () => {
    const paths = resolveMaaPaths({ env: {}, platform: platform(), homedir: homedir() });

    assert.equal(paths.resourceDir, join(paths.dataDir, 'resource'));
    assert.equal(paths.logPath, join(paths.stateDir, 'debug', 'asst.log'));
    assert.equal(paths.itemIndexPath, join(paths.resourceDir, 'item_index.json'));
    assert.equal(paths.itemTablePath, join(paths.resourceDir, 'gamedata', 'excel', 'item_table.json'));
    assert.equal(paths.battleDataPath, join(paths.resourceDir, 'battle_data.json'));
  });
});

describe('printPathConfig', () => {
  const originalConsoleLog = console.log;
  const printedLines: string[] = [];

  afterEach(() => {
    console.log = originalConsoleLog;
    printedLines.length = 0;
  });

  it('prints the same resolution as resolveMaaPaths for the current platform', () => {
    console.log = (...args: unknown[]) => printedLines.push(args.map(String).join(' '));
    printPathConfig();

    const current = resolveMaaPaths();
    const osType = platform() === 'darwin'
      ? 'macOS'
      : platform() === 'linux'
        ? 'Linux'
        : platform() === 'win32'
          ? 'Windows'
          : platform();
    assert.deepEqual(printedLines, [
      '=== MAA 路径配置 ===',
      `操作系统: ${osType}`,
      `配置目录: ${current.configDir}`,
      `数据目录: ${current.dataDir}`,
      `State目录: ${current.stateDir}`,
      `资源目录: ${current.resourceDir}`,
      `日志文件: ${current.logPath}`,
      '=================='
    ]);
  });
});
