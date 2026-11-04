import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEnvSource } from './runtimeConfig.ts';

export interface MaaPathOptions {
  env?: RuntimeEnvSource;
  platform?: NodeJS.Platform;
  homedir?: string;
}

export interface MaaPaths {
  configDir: string;
  dataDir: string;
  stateDir: string;
  resourceDir: string;
  logPath: string;
  itemIndexPath: string;
  itemTablePath: string;
  battleDataPath: string;
}

/** 与 maa-cli 一致：显式目录变量优先于 XDG，空值按未设置处理。 */
function readDirOverride(env: RuntimeEnvSource, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function resolveMaaConfigDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  const override = readDirOverride(env, 'MAA_CONFIG_DIR');
  if (override) return override;
  switch (platformName) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'maa');
    case 'win32':
      return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'maa');
    default:
      return join(home, '.config', 'maa');
  }
}

function resolveMaaDataDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  const override = readDirOverride(env, 'MAA_DATA_DIR');
  if (override) return override;
  switch (platformName) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'maa');
    case 'win32':
      return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'maa');
    default:
      return join(home, '.local', 'share', 'maa');
  }
}

function resolveMaaStateDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  const override = readDirOverride(env, 'MAA_STATE_DIR');
  if (override) return override;
  switch (platformName) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'maa');
    case 'win32':
      return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'maa');
    default:
      return join(home, '.local', 'state', 'maa');
  }
}

/** 解析全部外部 MAA 路径；可注入环境、平台与家目录，导入与调用均无副作用。 */
export function resolveMaaPaths(options: MaaPathOptions = {}): MaaPaths {
  const env = options.env ?? process.env;
  const platformName = options.platform ?? platform();
  const home = options.homedir ?? homedir();

  const configDir = resolveMaaConfigDir(env, platformName, home);
  const dataDir = resolveMaaDataDir(env, platformName, home);
  const stateDir = resolveMaaStateDir(env, platformName, home);
  const resourceDir = join(dataDir, 'resource');

  return {
    configDir,
    dataDir,
    stateDir,
    resourceDir,
    logPath: join(stateDir, 'debug', 'asst.log'),
    itemIndexPath: join(resourceDir, 'item_index.json'),
    itemTablePath: join(resourceDir, 'gamedata', 'excel', 'item_table.json'),
    battleDataPath: join(resourceDir, 'battle_data.json')
  };
}

export function getMaaLogPath(): string {
  return resolveMaaPaths().logPath;
}

export function getMaaResourceDir(): string {
  return resolveMaaPaths().resourceDir;
}

export function getItemIndexPath(): string {
  return resolveMaaPaths().itemIndexPath;
}

export function getItemTablePath(): string {
  return resolveMaaPaths().itemTablePath;
}

export function getBattleDataPath(): string {
  return resolveMaaPaths().battleDataPath;
}

function getOSType(platformName: NodeJS.Platform): string {
  switch (platformName) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platformName;
  }
}

export function printPathConfig(): void {
  const paths = resolveMaaPaths();
  console.log('=== MAA 路径配置 ===');
  console.log('操作系统:', getOSType(platform()));
  console.log('配置目录:', paths.configDir);
  console.log('数据目录:', paths.dataDir);
  console.log('State目录:', paths.stateDir);
  console.log('资源目录:', paths.resourceDir);
  console.log('日志文件:', paths.logPath);
  console.log('==================');
}
