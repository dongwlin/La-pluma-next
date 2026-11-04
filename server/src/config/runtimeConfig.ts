/**
 * 导入时无副作用；路径按本模块位置锚定、与进程 cwd 无关，环境变量仅在入参缺省时读取，
 * 不固化成共享全局。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeEnvSource = Readonly<Record<string, string | undefined>>;

/** 配置值非法时抛出；`variableName` 标识出错的变量，`code` 供程序化识别。 */
export class RuntimeConfigError extends Error {
  code: string;
  variableName: string;

  constructor(message: string, variableName: string) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = 'RUNTIME_CONFIG_INVALID';
    this.variableName = variableName;
  }
}

export interface NumericEnvOptions {
  name: string;
  fallback: number;
}

export interface BooleanEnvOptions {
  name: string;
  fallback: boolean;
}

function readRawNumber(raw: string | undefined, options: NumericEnvOptions): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new RuntimeConfigError(
      `环境变量 ${options.name} 不是合法数字: ${JSON.stringify(raw)}`,
      options.name
    );
  }
  return parsed;
}

/**
 * 解析端口环境变量：接受 0-65535 的整数（0 保留原有的“随机端口”语义），
 * 缺失或空白回退默认值，其余输入抛出 RuntimeConfigError。
 */
export function parsePort(raw: string | undefined, options: NumericEnvOptions): number {
  const parsed = readRawNumber(raw, options);
  if (parsed === null) return options.fallback;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new RuntimeConfigError(
      `环境变量 ${options.name} 必须是 0-65535 之间的整数，收到: ${JSON.stringify(raw)}`,
      options.name
    );
  }
  return parsed;
}

/**
 * 解析正整数环境变量（时限、缓存上限等）；
 * 缺失或空白回退默认值，非正整数或非数字抛出 RuntimeConfigError。
 * 注意：旧有读取点（如 WebRTC 时限、实时日志上限）目前对非法值静默回退，
 * 各领域任务接入本解析时需按任务验收决定是否收紧并记录兼容差异。
 */
export function parsePositiveInteger(raw: string | undefined, options: NumericEnvOptions): number {
  const parsed = readRawNumber(raw, options);
  if (parsed === null) return options.fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeConfigError(
      `环境变量 ${options.name} 必须是正整数，收到: ${JSON.stringify(raw)}`,
      options.name
    );
  }
  return parsed;
}

const TRUE_SWITCH_VALUES = '1/true/yes/on';
const FALSE_SWITCH_VALUES = '0/false/no/off';

/**
 * 解析布尔开关环境变量：接受 1/true/yes/on 与 0/false/no/off（大小写不敏感），
 * 缺失或空白回退默认值，其余输入抛出 RuntimeConfigError。
 * 注意：旧有开关（如 DOCKER_ENV 的“非空即真”）语义不同，接入时由领域任务决定并记录差异。
 */
export function parseBooleanSwitch(raw: string | undefined, options: BooleanEnvOptions): boolean {
  if (raw === undefined || raw.trim() === '') return options.fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_SWITCH_VALUES.split('/').includes(normalized)) return true;
  if (FALSE_SWITCH_VALUES.split('/').includes(normalized)) return false;
  throw new RuntimeConfigError(
    `环境变量 ${options.name} 必须是 ${TRUE_SWITCH_VALUES} 或 ${FALSE_SWITCH_VALUES} 之一，收到: ${JSON.stringify(raw)}`,
    options.name
  );
}

export interface AppPathOptions {
  env?: RuntimeEnvSource;
  serverRoot?: string;
}

export interface AppPaths {
  serverRoot: string;
  appDataDir: string;
  agentRunStorePath: string;
  userConfigsDir: string;
  dropRecordsDir: string;
  executionLockPath: string;
  trainingDataDir: string;
  materialsPath: string;
  materialFormulasPath: string;
  operatorMaterialsPath: string;
  operatorQuotesPath: string;
  penguinDropDataPath: string;
  depotPath: string;
  operboxPath: string;
  tempResourceDir: string;
  frontendDistDir: string;
}

// 纯路径计算，不构成导入副作用；锚定本模块位置使解析结果与 cwd 无关。
const moduleServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 解析应用运行路径。五个类别互不混用：持久数据、内置/解析数据共享 server/data
 * 根目录但由不同字段区分；临时目录与前端产物独立锚定；外部 MAA 路径见 paths.ts。
 */
export function resolveAppPaths(options: AppPathOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const serverRoot = resolve(options.serverRoot ?? moduleServerRoot);
  const appDataDir = join(serverRoot, 'data');
  const trainingDataDir = env.LA_PLUMA_TRAINING_DATA_DIR || appDataDir;
  return {
    serverRoot,
    appDataDir,
    agentRunStorePath: env.LA_PLUMA_AGENT_RUN_STORE || join(appDataDir, 'agent-runs.json'),
    userConfigsDir: join(appDataDir, 'user-configs'),
    dropRecordsDir: env.LA_PLUMA_DROP_RECORDS_DIR || join(appDataDir, 'drop-records'),
    executionLockPath: env.LA_PLUMA_MAA_LOCK_FILE || join(appDataDir, 'maa-execution.lock'),
    trainingDataDir,
    materialsPath: join(trainingDataDir, 'materials.json'),
    materialFormulasPath: join(trainingDataDir, 'material-formulas.json'),
    operatorMaterialsPath: join(trainingDataDir, 'operator-materials.json'),
    operatorQuotesPath: join(appDataDir, 'operatorQuotes.json'),
    penguinDropDataPath: join(trainingDataDir, 'penguin-drop-data.json'),
    depotPath: join(trainingDataDir, 'depot.json'),
    operboxPath: join(trainingDataDir, 'operbox.json'),
    tempResourceDir: join(serverRoot, '.temp-maa-resource'),
    frontendDistDir: resolve(serverRoot, '..', 'client', 'dist')
  };
}

/**
 * 规范化生产环境前端挂载路径：空值与 `/` 归一为根部署，
 * 其余值补齐前导与结尾斜杠（`la-pluma`、`/la-pluma/` 均得 `/la-pluma/`）。
 */
export function normalizeBasePath(value?: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${withLeadingSlash.replace(/\/+$/, '')}/`;
}

export interface HttpsOptions {
  cert: string | Buffer;
  key: string | Buffer;
}

export type ReadFileSyncLike = (path: string) => string | Buffer;

/**
 * 解析可选 HTTPS 配置：两个路径变量都缺失时返回 null（使用 HTTP），
 * 只配置其一时抛出错误，同时配置时读取证书与私钥文件内容。
 */
export function loadHttpsOptions(
  env: RuntimeEnvSource,
  readFile: ReadFileSyncLike = (path: string) => readFileSync(path)
): HttpsOptions | null {
  const certPath = env.LA_PLUMA_HTTPS_CERT_PATH?.trim();
  const keyPath = env.LA_PLUMA_HTTPS_KEY_PATH?.trim();
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error('LA_PLUMA_HTTPS_CERT_PATH 和 LA_PLUMA_HTTPS_KEY_PATH 必须同时配置');
  }
  return {
    cert: readFile(certPath),
    key: readFile(keyPath)
  };
}

export interface ConnectionDefaults {
  adbPath: string;
  adbAddress: string;
  clientType: string;
  maaCliPath: string;
}

const PLATFORM_ADB_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/opt/homebrew/bin/adb',
  linux: '/usr/bin/adb',
  win32: 'adb.exe'
};
/** 未知平台的保守回退；容器镜像始终安装 Debian 的 `/usr/bin/adb`。 */
const FALLBACK_ADB_PATH = '/usr/bin/adb';
const DOCKER_ADB_PATH = '/usr/bin/adb';
const FALLBACK_ADB_ADDRESS = '127.0.0.1:16384';
const FALLBACK_CLIENT_TYPE = 'Official';
const DOCKER_MAA_CLI_PATH = '/usr/local/bin/maa';
const LOCAL_MAA_CLI_PATH = 'maa';

export interface ConnectionDefaultsOptions {
  platform?: NodeJS.Platform;
}

/**
 * 解析连接默认值；缺失或空字符串回退，`DOCKER_ENV` 非空时 ADB 与 CLI
 * 缺省为容器路径。与其余解析函数一致，显式入参优先，入参缺省时才读取
 * 当前进程环境。
 */
export function resolveConnectionDefaults(
  env: RuntimeEnvSource = process.env,
  options: ConnectionDefaultsOptions = {}
): ConnectionDefaults {
  const platformName = options.platform ?? process.platform;
  const localAdbPath = PLATFORM_ADB_PATHS[platformName] || FALLBACK_ADB_PATH;
  return {
    adbPath: env.ADB_PATH || (env.DOCKER_ENV ? DOCKER_ADB_PATH : localAdbPath),
    adbAddress: env.ADB_ADDRESS || FALLBACK_ADB_ADDRESS,
    clientType: env.MAA_CLIENT_TYPE || FALLBACK_CLIENT_TYPE,
    maaCliPath: env.MAA_CLI_PATH || (env.DOCKER_ENV ? DOCKER_MAA_CLI_PATH : LOCAL_MAA_CLI_PATH)
  };
}
