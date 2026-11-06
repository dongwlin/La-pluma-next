/**
 * 资源信息读取与同步：读取可重复执行，CLI/JSON 均从 unknown 收窄；部分候选目录
 * 读取失败但仍有可用信息时标记 `degraded`，全部失败才抛出且内部不重试；
 * 写操作持有设备变更租约，同一时间只允许一次真实更新：已有更新进行中时，并发调用立即以
 * `AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS` 失败，不排队、不共享首个请求的结果；
 * 更新经 maa-cli 原生 `hot-update` 执行，Git 更新在启动子进程前核验官方仓库。
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import type { MaaExecutionLease, MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { MAINTENANCE_EXEC_TIMEOUT_MS } from './maaProcessService.ts';
import type { MaaProcessLifecycle } from './maaProcessService.ts';
import { RESOURCE_SOURCE_TYPES, readResourceSourceConfig } from './resourceSourceService.ts';
import type { ResourceSourceType } from './resourceSourceService.ts';

const logger = createLogger('MaaService');

const STALE_RESOURCE_DAYS = 14;

/** 并发资源更新的稳定错误码：第二个请求未开始就被拒绝，而不是等待首个结束。 */
export const RESOURCE_UPDATE_IN_PROGRESS_CODE = 'AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS';

/** 已有资源更新在进行：请求被拒绝但可重试，`details` 由 HTTP 层补齐正在进行的 run。 */
export function createResourceUpdateInProgressError(
  message = '已有资源更新正在进行，请等待当前更新完成',
  details: Record<string, unknown> = {}
): AgentError {
  return agentError(RESOURCE_UPDATE_IN_PROGRESS_CODE, message, {
    statusCode: 409,
    retryable: true,
    details
  });
}

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
  degraded?: boolean;
}

/** `version.json` 的已解析视图；只有 `last_updated` 参与新鲜度判断。 */
export interface ResourceVersionMetadata {
  lastUpdated: string | null;
  activity: unknown;
  gacha: unknown;
}

export interface ResourceUpdateResult {
  output: string;
  resource: ResourceInfo;
}

export interface ResourceVersionFile {
  content: string;
  modifiedAt: Date;
}

/** 执行租约端口：整次更新在租约回调内执行；缺省 `withMaaExecutionLease`。 */
export type MaaExecutionLeaseRunner = (
  owner: MaaExecutionLeaseRequest,
  callback: (lease: MaaExecutionLease) => Promise<ResourceUpdateResult>
) => Promise<ResourceUpdateResult>;

export interface ResourceUpdateServicePorts {
  resolveResourceDirs?: () => Promise<string[]>;
  readVersionFile?: (versionPath: string) => Promise<ResourceVersionFile>;
  now?: () => Date;
  runHotUpdate?: (options?: ResourceUpdateRunOptions) => Promise<string>;
  withLease?: MaaExecutionLeaseRunner;
}

/** 一次资源更新的执行边界；`lifecycle` 由调用的 Run 提供，用于开始门禁与终态回调。 */
export interface ResourceUpdateRunOptions {
  lifecycle?: MaaProcessLifecycle;
}

export interface ResourceUpdateService {
  getResourceInfo(): Promise<ResourceInfo>;
  updateResources(options?: ResourceUpdateRunOptions): Promise<ResourceUpdateResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoentError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

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

function parseVersionTimestamp(lastUpdated: string | null): number | null {
  if (!lastUpdated) return null;
  const parsed = new Date(lastUpdated.replace(' ', 'T').replace(/\.000$/, 'Z'));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function buildResourceInfoFromMetadata(
  metadata: ResourceVersionMetadata,
  modifiedAt: unknown,
  now: Date
): ResourceInfo {
  const parsedTimestamp = parseVersionTimestamp(metadata.lastUpdated);
  const ageDays = parsedTimestamp === null
    ? null
    : Math.max(0, Math.floor((now.getTime() - parsedTimestamp) / 86400000));
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
 * 由版本元数据构建资源信息；`versionData` 与 `modifiedAt` 均按 unknown 收窄，
 * 只有真正的 `Date` 才进入输出，`last_updated` 规则与既有版本输出一致。
 */
export function buildResourceInfo(
  versionData: unknown = {},
  modifiedAt: unknown = null,
  now: Date = new Date()
): ResourceInfo {
  return buildResourceInfoFromMetadata(normalizeVersionMetadata(versionData), modifiedAt, now);
}

async function readMaaDir(name: string): Promise<string> {
  const result = await execMaaCommand('dir', [name], null, null, false, true);
  return result.stdout.trim();
}

/** ENOENT 视为该目录层不存在；命令失败等其它错误必须抛出，不能静默降级。 */
async function readOptionalMaaDir(name: string): Promise<string> {
  try {
    return await readMaaDir(name);
  } catch (error) {
    if (!isEnoentError(error)) {
      logger.error('读取 MAA 资源目录失败', { name, error: errorMessageOf(error) });
      throw error;
    }
    return '';
  }
}

/** MirrorChyan 快照根固定在数据目录的 `MirrorChyan/MaaResource` 下（与 maa-cli 一致）。 */
function mirrorChyanSnapshotRoot(dataRoot: string): string {
  return dataRoot.length > 0 ? join(dataRoot, 'MirrorChyan', 'MaaResource') : '';
}

/**
 * 与 maa-cli 的 `active_snapshot` 一致：`current.json` 是 JSON 字符串，只认单段
 * `snapshot-` 代目录名；缺失、非法或试图跳出快照根时回退代目录布局之前的快照根本身。
 */
export function selectMirrorChyanSnapshotDir(snapshotRoot: string, pointer: string | null): string {
  if (snapshotRoot.length === 0) return '';
  if (pointer === null) return snapshotRoot;
  let generation: unknown;
  try {
    generation = JSON.parse(pointer);
  } catch {
    return snapshotRoot;
  }
  if (typeof generation === 'string'
    && generation.startsWith('snapshot-')
    && !generation.includes('/')
    && !generation.includes('\\')) {
    return join(snapshotRoot, generation);
  }
  return snapshotRoot;
}

function joinResourceDir(root: string): string {
  return root.length > 0 ? join(root, 'resource') : '';
}

async function readMirrorChyanPointer(dataRoot: string): Promise<string | null> {
  const pointerPath = join(mirrorChyanSnapshotRoot(dataRoot), 'current.json');
  try {
    return await readFile(pointerPath, 'utf-8');
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
}

/** 单一来源的基础资源目录；`tolerateFailure` 供资源源配置不可读时的兜底探测使用。 */
async function readBaseResourceDir(source: ResourceSourceType, tolerateFailure: boolean): Promise<string> {
  try {
    if (source === 'mirrorchyan') {
      const dataRoot = await readMaaDir('data');
      if (dataRoot.length === 0) return '';
      const pointer = await readMirrorChyanPointer(dataRoot);
      return joinResourceDir(selectMirrorChyanSnapshotDir(mirrorChyanSnapshotRoot(dataRoot), pointer));
    }
    return joinResourceDir(await readOptionalMaaDir('hot-update'));
  } catch (error) {
    if (!tolerateFailure) throw error;
    logger.warn('探测 MAA 资源基础目录失败，跳过该来源', { source, error: errorMessageOf(error) });
    return '';
  }
}

/**
 * MaaCore 按“MaaCore 附带资源 → 资源源基础资源”的顺序加载，后加载者覆盖同名文件；
 * 基础资源由 cli.toml 的资源源决定：Git 源在 `maa dir hot-update` 的 checkout 里，
 * MirrorChyan 源在数据目录下由 `current.json` 选择的代快照里。状态探测必须跟随
 * 同一选择，否则会按已停用的 Git checkout 误报资源过期。资源源配置不可读时无法
 * 确定生效来源，同时探测两种来源并各自容忍失败，不让配置损坏放大成资源状态不可用
 * （与更新流程对频道持久化失败的降级口径一致）。
 */
async function readMaaResourceDirsFromCli(): Promise<string[]> {
  let sources: readonly ResourceSourceType[];
  try {
    sources = [(await readResourceSourceConfig()).source];
  } catch (error) {
    logger.warn('读取 MAA 资源源配置失败，同时探测两种来源的资源目录', { error: errorMessageOf(error) });
    sources = RESOURCE_SOURCE_TYPES;
  }
  const tolerateFailure = sources.length > 1;
  const coreResourceDir = await readMaaDir('resource');
  const baseResourceDirs = await Promise.all(sources.map(source => readBaseResourceDir(source, tolerateFailure)));
  return [...new Set([coreResourceDir, ...baseResourceDirs].filter(dir => dir.length > 0))];
}

async function readResourceVersionFile(versionPath: string): Promise<ResourceVersionFile> {
  const [content, fileStat] = await Promise.all([
    readFile(versionPath, 'utf-8'),
    stat(versionPath)
  ]);
  return { content, modifiedAt: fileStat.mtime };
}

async function runMaaHotUpdate(options: ResourceUpdateRunOptions = {}): Promise<string> {
  const result = await execMaaCommand('hot-update', [], null, null, false, false, options.lifecycle, {
    execFileTimeoutMs: MAINTENANCE_EXEC_TIMEOUT_MS,
    managedTaskName: '同步 MAA 资源'
  });
  return result.stdout || result.stderr;
}

/**
 * 创建资源服务实例；single-flight 状态保存在实例内，测试可创建隔离实例。
 * 进行中的更新只对持有者可见：并发调用直接得到冲突错误，不会复用首个请求的 Promise。
 */
export function createResourceUpdateService(ports: ResourceUpdateServicePorts = {}): ResourceUpdateService {
  const resolveResourceDirs = ports.resolveResourceDirs ?? readMaaResourceDirsFromCli;
  const readVersionFile = ports.readVersionFile ?? readResourceVersionFile;
  const now = ports.now ?? (() => new Date());
  const runHotUpdate = ports.runHotUpdate ?? runMaaHotUpdate;
  const runWithLease = ports.withLease ?? withMaaExecutionLease;
  let activeUpdate: Promise<ResourceUpdateResult> | null = null;

  async function getResourceInfo(): Promise<ResourceInfo> {
    const resourceDirs = await resolveResourceDirs();
    const readAt = now();
    let selected: { info: ResourceInfo; timestamp: number | null } | null = null;
    let lastError: unknown = null;
    let degraded = false;

    for (const resourceDir of resourceDirs) {
      const versionPath = join(resourceDir, 'version.json');
      try {
        const versionFile = await readVersionFile(versionPath);
        const metadata = parseResourceVersion(versionFile.content);
        const timestamp = parseVersionTimestamp(metadata.lastUpdated);
        const info = buildResourceInfoFromMetadata(metadata, versionFile.modifiedAt, readAt);
        if (!selected || (timestamp ?? Number.NEGATIVE_INFINITY) >= (selected.timestamp ?? Number.NEGATIVE_INFINITY)) {
          selected = { info, timestamp };
        }
      } catch (error) {
        lastError = error;
        if (!isEnoentError(error)) {
          degraded = true;
          logger.warn('读取 MAA 资源版本文件失败，继续使用其它候选目录', {
            path: versionPath,
            error: errorMessageOf(error)
          });
        }
      }
    }

    if (!selected) throw lastError ?? new Error('无法读取 MAA 资源版本');
    return degraded ? { ...selected.info, degraded: true } : selected.info;
  }

  async function performUpdate(options: ResourceUpdateRunOptions): Promise<ResourceUpdateResult> {
    const output = await runHotUpdate(options);
    return {
      output,
      resource: await getResourceInfo()
    };
  }

  async function updateResources(options: ResourceUpdateRunOptions = {}): Promise<ResourceUpdateResult> {
    if (activeUpdate) throw createResourceUpdateInProgressError();

    const run = runWithLease({
      source: 'resource-update',
      taskName: '同步 MAA 资源',
      command: 'hot-update'
    }, () => performUpdate(options));
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

/** 读取当前 MAA 资源信息；所有候选目录都不可读时抛出。 */
export function getMaaResourceInfo(): Promise<ResourceInfo> {
  return defaultService.getResourceInfo();
}

/**
 * 解析携带版本信息的资源候选目录（MaaCore 附带资源与资源源基础资源，按加载
 * 顺序排列）；目录查询或资源源配置解析失败时抛出。
 */
export function getMaaResourceDirs(): Promise<string[]> {
  return readMaaResourceDirsFromCli();
}

/**
 * 同步 MAA 资源并返回更新后的信息。已有更新进行中时立即抛出
 * `AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS`（409，可重试），不排队也不复用首个结果；
 * 失败原样抛出且不自动重试。
 */
export function updateMaaResources(options: ResourceUpdateRunOptions = {}): Promise<ResourceUpdateResult> {
  return defaultService.updateResources(options);
}

function errorMessageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** 资源信息读取失败时的既有兜底投影：状态按 `unknown` 处理，不能当成正常。 */
export function buildResourceInfoFallback(error: unknown): ResourceInfo {
  return {
    lastUpdated: null,
    modifiedAt: null,
    ageDays: null,
    status: 'unknown',
    message: `资源版本读取失败: ${errorMessageOf(error)}`,
    activity: null,
    gacha: null
  };
}
