/**
 * 运行配置与路径入口
 *
 * 提供不依赖进程 cwd、可注入的配置解析与路径分类：
 * - 应用持久数据（运行期间写入 server/data，如 Run 存储、用户配置、掉落记录、执行锁）
 * - 内置/解析数据（脚本生成或执行产物，同样位于 server/data）
 * - 临时目录（资源更新脚本暂存）
 * - 前端产物（client/dist，生产静态资源）
 *
 * 外部 MAA 路径由 `./paths.ts` 的 `resolveMaaPaths` 解析；ADB/MAA CLI 等连接默认值
 * 由本入口的 `resolveConnectionDefaults` 解析，具名常量在 `./connectionDefaults.ts`
 * 按导入时环境固化一次，业务模块只消费常量或解析结果。
 *
 * 本模块导入时无副作用：不读取环境变量、不访问文件系统、不注册监听。
 * 所有解析通过显式入参完成；入参缺省时才读取当前进程环境或按本模块位置锚定路径，
 * 因此从任意 cwd 启动结果一致，且不会把进程环境固化成共享全局。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 可注入的环境变量来源；`process.env` 天然满足该结构。 */
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
  /** 环境变量名，用于错误信息定位 */
  name: string;
  /** 变量缺失或为空白时使用的默认值 */
  fallback: number;
}

export interface BooleanEnvOptions {
  /** 环境变量名，用于错误信息定位 */
  name: string;
  /** 变量缺失或为空白时使用的默认值 */
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
  /** 覆盖进程环境（LA_PLUMA_* 覆盖变量）；缺省读取 process.env */
  env?: RuntimeEnvSource;
  /** 覆盖 server 源码根目录锚点；缺省按本模块位置解析，不依赖 cwd */
  serverRoot?: string;
}

export interface AppPaths {
  /** server 源码根目录，全部应用内路径的解析锚点 */
  serverRoot: string;
  /** 应用持久数据根目录（server/data，运行数据不入库） */
  appDataDir: string;
  /** Agent Run 与幂等记录存储文件（覆盖变量 LA_PLUMA_AGENT_RUN_STORE） */
  agentRunStorePath: string;
  /** 用户配置存储目录 */
  userConfigsDir: string;
  /** 掉落记录目录（覆盖变量 LA_PLUMA_DROP_RECORDS_DIR） */
  dropRecordsDir: string;
  /** MAA 执行互斥锁文件（覆盖变量 LA_PLUMA_MAA_LOCK_FILE） */
  executionLockPath: string;
  /** 养成数据目录（覆盖变量 LA_PLUMA_TRAINING_DATA_DIR，默认与 appDataDir 相同） */
  trainingDataDir: string;
  /** 内置数据：养成材料表（脚本生成） */
  materialsPath: string;
  /** 内置数据：材料合成公式（脚本生成） */
  materialFormulasPath: string;
  /** 内置数据：干员养成材料（脚本生成） */
  operatorMaterialsPath: string;
  /** 台词数据（内置种子，运行期可更新） */
  operatorQuotesPath: string;
  /** 内置数据：企鹅物流掉落数据（脚本抓取） */
  penguinDropDataPath: string;
  /** 执行产物：仓库识别结果 */
  depotPath: string;
  /** 执行产物：干员识别结果 */
  operboxPath: string;
  /** 资源更新脚本暂存目录 */
  tempResourceDir: string;
  /** 前端构建产物目录（生产静态资源与 SPA fallback） */
  frontendDistDir: string;
}

// 纯路径计算，不构成导入副作用；锚定本模块位置使解析结果与 cwd 无关。
const moduleServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 解析应用运行路径。五个类别互不混用：持久数据、内置/解析数据共享 server/data
 * 根目录但由不同字段区分；临时目录与前端产物独立锚定；外部 MAA 路径见 paths.ts。
 */
export function resolveAppPaths(options: AppPathOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const serverRoot = resolve(options.serverRoot ?? moduleServerRoot);
  const appDataDir = join(serverRoot, 'data');
  return {
    serverRoot,
    appDataDir,
    agentRunStorePath: env.LA_PLUMA_AGENT_RUN_STORE || join(appDataDir, 'agent-runs.json'),
    userConfigsDir: join(appDataDir, 'user-configs'),
    dropRecordsDir: env.LA_PLUMA_DROP_RECORDS_DIR || join(appDataDir, 'drop-records'),
    executionLockPath: env.LA_PLUMA_MAA_LOCK_FILE || join(appDataDir, 'maa-execution.lock'),
    trainingDataDir: env.LA_PLUMA_TRAINING_DATA_DIR || appDataDir,
    materialsPath: join(appDataDir, 'materials.json'),
    materialFormulasPath: join(appDataDir, 'material-formulas.json'),
    operatorMaterialsPath: join(appDataDir, 'operator-materials.json'),
    operatorQuotesPath: join(appDataDir, 'operatorQuotes.json'),
    penguinDropDataPath: join(appDataDir, 'penguin-drop-data.json'),
    depotPath: join(appDataDir, 'depot.json'),
    operboxPath: join(appDataDir, 'operbox.json'),
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

/** ADB 与 MAA CLI 的连接默认值。 */
export interface ConnectionDefaults {
  /** ADB 可执行文件路径（`ADB_PATH`） */
  adbPath: string;
  /** 默认 ADB 设备地址（`ADB_ADDRESS`） */
  adbAddress: string;
  /** 默认客户端类型（`MAA_CLIENT_TYPE`） */
  clientType: string;
  /** MAA CLI 可执行文件路径（`MAA_CLI_PATH`；Docker 缺省 `/usr/local/bin/maa`） */
  maaCliPath: string;
}

/** 本地安装默认值：与各平台官方/包管理器常见安装位置一致。 */
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
  /** 覆盖目标平台；缺省 process.platform。 */
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
