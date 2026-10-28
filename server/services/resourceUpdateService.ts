/**
 * MAA 资源信息读取与资源同步
 *
 * 两类操作分开建模：
 * - **读取**（`getResourceInfo`）：查询 `maa dir resource` 并解析 `version.json`，
 *   可重复执行；CLI 输出、JSON 内容都从 `unknown` 收窄，解析失败向调用方抛出，
 *   模块内部不重试。
 * - **更新**（`updateResources`）：运行资源更新脚本并重新读取资源信息。写操作
 *   具备以下显式语义：
 *   - 执行互斥：整次更新持有 `executionCoordinatorService` 的设备变更租约，
 *     与 MAA 命令串行；租约只在实际结束后释放。
 *   - 单次共享（single-flight）：并发调用共享同一个进行中的 Promise，只启动
 *     一个脚本进程，所有调用方得到相同结果或相同失败，不排队、不重放。
 *   - 时限：`timeoutMs` 缺省为 `null`（资源下载时长不可预知，不擅自中断写操作）；
 *     调用方显式设置时，超时先 SIGTERM，宽限后升级 SIGKILL，失败向上抛出，
 *     不自动重试。
 *   - 取消：写操作不支持调用方取消（中断更新可能留下不完整资源）；单个调用方
 *     放弃等待只影响该调用方，不终止共享的底层更新。
 *
 * 更新脚本的临时目录由脚本自身锚定（`server/.temp-maa-resource`，与运行路径
 * 入口的 `tempResourceDir` 一致）；脚本路径与工作目录经运行路径入口解析，不
 * 依赖进程 cwd。
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/runtimeConfig.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import type { MaaExecutionLease, MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import { execMaaCommand } from './maaExecutionService.ts';

const STALE_RESOURCE_DAYS = 14;
const DEFAULT_FORCE_KILL_DELAY_MS = 5000;

/** 资源新鲜度：`unknown` 表示无法读取版本时间，不能当成正常。 */
export type ResourceStatus = 'current' | 'stale' | 'unknown';

/** 资源信息投影；`activity`/`gacha` 原样透传 `version.json` 字段。 */
export interface ResourceInfo {
  lastUpdated: string | null;
  modifiedAt: string | null;
  ageDays: number | null;
  status: ResourceStatus;
  message: string;
  activity: unknown;
  gacha: unknown;
}

/** `version.json` 的已解析视图；只有 `last_updated` 参与新鲜度判断。 */
export interface ResourceVersionMetadata {
  lastUpdated: string | null;
  activity: unknown;
  gacha: unknown;
}

/** 更新结果：脚本输出与更新后重新读取的资源信息。 */
export interface ResourceUpdateResult {
  output: string;
  resource: ResourceInfo;
}

/** 版本文件读取结果；`modifiedAt` 保留文件系统修改时间。 */
export interface ResourceVersionFile {
  content: string;
  modifiedAt: Date;
}

/** 更新脚本子进程的输出流端口。 */
export interface ResourceUpdateOutputStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

/** 更新脚本子进程的最小能力；与 `maaProcessService` 的子进程端口同形状。 */
export interface ResourceUpdateChild {
  readonly stdout: ResourceUpdateOutputStream | null;
  readonly stderr: ResourceUpdateOutputStream | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ResourceUpdateSpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export type ResourceUpdateSpawn = (
  command: string,
  args: readonly string[],
  options: ResourceUpdateSpawnOptions
) => ResourceUpdateChild;

/** 计时器句柄；测试端口用假句柄时只需实现 unref。 */
export interface ResourceUpdateTimer {
  unref?(): void;
}

export interface ResourceUpdateTimers {
  setTimeout?(callback: () => void, delayMs: number): ResourceUpdateTimer;
  clearTimeout?(timer: ResourceUpdateTimer): void;
}

/** 执行租约端口：整次更新在租约回调内执行；缺省 `withMaaExecutionLease`。 */
export type MaaExecutionLeaseRunner = (
  owner: MaaExecutionLeaseRequest,
  callback: (lease: MaaExecutionLease) => Promise<ResourceUpdateResult>
) => Promise<ResourceUpdateResult>;

export interface ResourceUpdateServicePorts {
  /** `maa dir resource` 解析端口；缺省执行 MAA CLI */
  resolveResourceDir?: () => Promise<string>;
  /** `version.json` 读取端口；缺省读取真实文件 */
  readVersionFile?: (versionPath: string) => Promise<ResourceVersionFile>;
  /** 当前时间；缺省 `new Date()` */
  now?: () => Date;
  /** 更新脚本子进程端口；缺省 `child_process.spawn` */
  spawn?: ResourceUpdateSpawn;
  /** 时限与升级计时器端口；缺省全局计时器 */
  timers?: ResourceUpdateTimers;
  /** 更新脚本路径；缺省按运行路径入口锚定 */
  scriptPath?: string;
  /** 更新脚本工作目录；缺省运行路径入口的 `serverRoot` */
  cwd?: string;
  /** 显式时限（毫秒）；缺省 null 表示不设时限 */
  timeoutMs?: number | null;
  /** SIGTERM 后升级 SIGKILL 的宽限（毫秒） */
  forceKillDelayMs?: number;
  /** 执行租约端口；缺省 `withMaaExecutionLease` */
  withLease?: MaaExecutionLeaseRunner;
}

export interface ResourceUpdateService {
  getResourceInfo(): Promise<ResourceInfo>;
  updateResources(): Promise<ResourceUpdateResult>;
}

/** 显式时限内更新进程未退出：已被终止，失败不重试。 */
export class ResourceUpdateTimeoutError extends Error {
  code: string;
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`资源更新超时（${timeoutMs}ms），已终止更新进程`);
    this.name = 'ResourceUpdateTimeoutError';
    this.code = 'MAA_RESOURCE_UPDATE_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 `unknown` 值收窄版本元数据；非对象或缺失字段按未知处理。 */
function normalizeVersionMetadata(value: unknown): ResourceVersionMetadata {
  const record = isRecord(value) ? value : {};
  return {
    lastUpdated: typeof record.last_updated === 'string' ? record.last_updated : null,
    activity: record.activity || null,
    gacha: record.gacha || null
  };
}

/** 解析 `version.json` 文本；JSON 非法时抛出，不透传非法结构。 */
export function parseResourceVersion(content: string): ResourceVersionMetadata {
  return normalizeVersionMetadata(JSON.parse(content));
}

/** 由已收窄的版本元数据构建资源信息；`last_updated` 规则与既有版本输出一致。 */
function buildResourceInfoFromMetadata(
  metadata: ResourceVersionMetadata,
  modifiedAt: Date | null,
  now: Date
): ResourceInfo {
  const parsedDate = metadata.lastUpdated
    ? new Date(metadata.lastUpdated.replace(' ', 'T').replace(/\.000$/, 'Z'))
    : null;
  const hasValidDate = parsedDate !== null && Number.isFinite(parsedDate.getTime());
  const ageDays = hasValidDate
    ? Math.max(0, Math.floor((now.getTime() - parsedDate.getTime()) / 86400000))
    : null;
  const status: ResourceStatus = ageDays === null ? 'unknown' : ageDays > STALE_RESOURCE_DAYS ? 'stale' : 'current';

  return {
    lastUpdated: metadata.lastUpdated,
    modifiedAt: modifiedAt instanceof Date ? modifiedAt.toISOString() : null,
    ageDays,
    status,
    message: status === 'stale'
      ? `资源已 ${ageDays} 天未更新，建议立即同步`
      : status === 'unknown'
        ? '无法读取资源版本，请重新同步资源'
        : '资源版本正常',
    activity: metadata.activity,
    gacha: metadata.gacha
  };
}

/**
 * 由版本元数据构建资源信息。`versionData` 来自文件或注入值，按 `unknown`
 * 收窄；`last_updated` 的解析规则与既有版本输出保持一致。
 */
export function buildResourceInfo(
  versionData: unknown = {},
  modifiedAt: Date | null = null,
  now: Date = new Date()
): ResourceInfo {
  return buildResourceInfoFromMetadata(normalizeVersionMetadata(versionData), modifiedAt, now);
}

const defaultTimers: Required<ResourceUpdateTimers> = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout)
};

/** `maa dir resource`：CLI 输出只取首尾空白外的一行目录。 */
async function readMaaResourceDirFromCli(): Promise<string> {
  const result = await execMaaCommand('dir', ['resource'], null, null, false, true);
  return result.stdout.trim();
}

async function readResourceVersionFile(versionPath: string): Promise<ResourceVersionFile> {
  const [content, fileStat] = await Promise.all([
    readFile(versionPath, 'utf-8'),
    stat(versionPath)
  ]);
  return { content, modifiedAt: fileStat.mtime };
}

/** 库边界收窄：`spawn` 返回的 ChildProcess 在本模块只用 close/error/data/kill。 */
const spawnResourceUpdateScript: ResourceUpdateSpawn = (command, args, options) => (
  spawn(command, [...args], { cwd: options.cwd, stdio: options.stdio }) as ResourceUpdateChild
);

/**
 * 创建资源服务实例。单次共享状态保存在实例内，测试可创建隔离实例；
 * 模块级 `getMaaResourceInfo`/`updateMaaResources` 使用缺省实例。
 */
export function createResourceUpdateService(ports: ResourceUpdateServicePorts = {}): ResourceUpdateService {
  const resolveResourceDir = ports.resolveResourceDir ?? readMaaResourceDirFromCli;
  const readVersionFile = ports.readVersionFile ?? readResourceVersionFile;
  const now = ports.now ?? (() => new Date());
  const spawnUpdate = ports.spawn ?? spawnResourceUpdateScript;
  const timers: Required<ResourceUpdateTimers> = { ...defaultTimers, ...ports.timers };
  const runWithLease = ports.withLease ?? withMaaExecutionLease;
  const timeoutMs = ports.timeoutMs ?? null;
  const forceKillDelayMs = ports.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS;
  let activeUpdate: Promise<ResourceUpdateResult> | null = null;

  async function getResourceInfo(): Promise<ResourceInfo> {
    const resourceDir = await resolveResourceDir();
    const versionPath = join(resourceDir.trim(), 'version.json');
    const versionFile = await readVersionFile(versionPath);
    return buildResourceInfoFromMetadata(parseResourceVersion(versionFile.content), versionFile.modifiedAt, now());
  }

  /** 运行一次更新脚本；时限到期先 SIGTERM，宽限后升级 SIGKILL，不做重试。 */
  function runUpdateScript(): Promise<string> {
    const appPaths = resolveAppPaths();
    const scriptPath = ports.scriptPath ?? join(appPaths.serverRoot, 'scripts', 'update-maa-resources.ts');
    const cwd = ports.cwd ?? appPaths.serverRoot;

    return new Promise<string>((resolve, reject) => {
      const child = spawnUpdate('node', [scriptPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timeoutTimer: ResourceUpdateTimer | null = null;
      let forceKillTimer: ResourceUpdateTimer | null = null;
      let timedOut = false;
      let settled = false;

      const clearTimers = (): void => {
        if (timeoutTimer) timers.clearTimeout(timeoutTimer);
        if (forceKillTimer) timers.clearTimeout(forceKillTimer);
        timeoutTimer = null;
        forceKillTimer = null;
      };

      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        outcome();
      };

      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });

      child.on('close', code => {
        settle(() => {
          if (timedOut) {
            reject(new ResourceUpdateTimeoutError(timeoutMs ?? 0));
            return;
          }
          if (code === 0) {
            resolve(stdout);
            return;
          }
          reject(new Error(stderr || stdout || `资源更新进程退出码 ${code}`));
        });
      });
      child.on('error', error => {
        settle(() => reject(error));
      });

      if (timeoutMs !== null) {
        timeoutTimer = timers.setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceKillTimer = timers.setTimeout(() => {
            child.kill('SIGKILL');
          }, forceKillDelayMs);
        }, timeoutMs);
      }
    });
  }

  async function performUpdate(): Promise<ResourceUpdateResult> {
    const output = await runUpdateScript();
    return {
      output,
      resource: await getResourceInfo()
    };
  }

  async function updateResources(): Promise<ResourceUpdateResult> {
    if (activeUpdate) return activeUpdate;

    const run = runWithLease({
      source: 'resource-update',
      taskName: '同步 MAA 资源',
      command: 'hot-update'
    }, () => performUpdate());
    activeUpdate = run;
    try {
      return await run;
    } finally {
      if (activeUpdate === run) activeUpdate = null;
    }
  }

  return { getResourceInfo, updateResources };
}

const defaultService = createResourceUpdateService();

/** 读取当前 MAA 资源信息；CLI 或版本文件不可读时抛出。 */
export function getMaaResourceInfo(): Promise<ResourceInfo> {
  return defaultService.getResourceInfo();
}

/**
 * 同步 MAA 资源并返回更新后的信息。并发调用共享同一次更新；
 * 失败原样抛出且不自动重试。
 */
export function updateMaaResources(): Promise<ResourceUpdateResult> {
  return defaultService.updateResources();
}
