/**
 * 外部 MAA 路径解析（跨平台）
 *
 * 解析 MAA CLI 安装的配置/数据/状态目录及其产物路径，行为与原实现一致：
 * - macOS：`~/Library/Application Support/com.loong.maa`
 * - Linux：XDG 标准，`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME`
 *   缺省回退 `~/.config`、`~/.local/share`、`~/.local/state`
 * - Windows：`APPDATA` / `LOCALAPPDATA` 缺省回退 `~/AppData/Roaming`、`~/AppData/Local`
 * - 其他平台：回退 Linux 风格
 *
 * `resolveMaaPaths` 为纯函数：平台、家目录与环境变量均可注入，便于跨平台 fixture；
 * 具名导出保持原有函数签名，委托到当前进程环境。应用内路径见 `./runtimeConfig.ts`。
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEnvSource } from './runtimeConfig.ts';

export interface MaaPathOptions {
  /** 覆盖进程环境（XDG_*、APPDATA、LOCALAPPDATA）；缺省读取 process.env */
  env?: RuntimeEnvSource;
  /** 覆盖目标平台；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** 覆盖用户家目录；缺省 os.homedir() */
  homedir?: string;
}

export interface MaaPaths {
  /** MAA CLI 配置目录（profiles 等） */
  configDir: string;
  /** MAA 数据目录（MaaCore 与资源文件） */
  dataDir: string;
  /** MAA 状态目录（日志、缓存等运行时数据） */
  stateDir: string;
  /** MAA 资源目录 */
  resourceDir: string;
  /** MAA 主日志文件 */
  logPath: string;
  /** 物品索引文件 */
  itemIndexPath: string;
  /** 游戏物品表文件 */
  itemTablePath: string;
  /** MAA 战斗数据文件（包含所有干员） */
  battleDataPath: string;
}

function resolveMaaConfigDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  switch (platformName) {
    case 'darwin': // macOS
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      // Linux 使用 XDG 标准
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'maa');
    case 'win32': // Windows
      return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'maa');
    default:
      // 默认使用 Linux 风格
      return join(home, '.config', 'maa');
  }
}

function resolveMaaDataDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  switch (platformName) {
    case 'darwin': // macOS
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      // Linux 使用 XDG 标准
      return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'maa');
    case 'win32': // Windows
      return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'maa');
    default:
      // 默认使用 Linux 风格
      return join(home, '.local', 'share', 'maa');
  }
}

function resolveMaaStateDir(env: RuntimeEnvSource, platformName: NodeJS.Platform, home: string): string {
  switch (platformName) {
    case 'darwin': // macOS
      return join(home, 'Library', 'Application Support', 'com.loong.maa');
    case 'linux':
      // Linux 使用 XDG 标准
      return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'maa');
    case 'win32': // Windows
      return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'maa');
    default:
      // 默认使用 Linux 风格
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

/** 获取 MAA 日志文件路径 */
export function getMaaLogPath(): string {
  return resolveMaaPaths().logPath;
}

/** 获取 MAA 资源目录路径 */
export function getMaaResourceDir(): string {
  return resolveMaaPaths().resourceDir;
}

/** 获取 MAA 物品索引文件路径 */
export function getItemIndexPath(): string {
  return resolveMaaPaths().itemIndexPath;
}

/** 获取游戏物品表文件路径 */
export function getItemTablePath(): string {
  return resolveMaaPaths().itemTablePath;
}

/** 获取 MAA 战斗数据文件路径（包含所有干员） */
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

/** 打印路径配置信息（服务器启动时输出当前系统解析结果，用于调试） */
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
