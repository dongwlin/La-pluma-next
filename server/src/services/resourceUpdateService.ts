/**
 * 资源信息读取与同步：读取可重复执行，CLI/JSON 均从 unknown 收窄、失败抛出且内部不重试；
 * 写操作持有设备变更租约，并发调用共享同一个进行中的 Promise（single-flight，不排队不重放），
 * 更新经 maa-cli 原生 `hot-update` 执行，资源源与凭据由 cli.toml 决定。
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import type { MaaExecutionLease, MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { MAINTENANCE_EXEC_TIMEOUT_MS } from './maaProcessService.ts';
import type { MaaProcessLifecycle } from './maaProcessService.ts';

const STALE_RESOURCE_DAYS = 14;

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

/**
 * MaaCore 按“基础资源 → 热更新覆盖层”的顺序加载，热更新只写覆盖层。
 * 两处都读、按 `last_updated` 取较新者，避免只读基础资源时看不到 `hot-update` 的结果。
 */
async function readMaaResourceDirsFromCli(): Promise<string[]> {
  const resourceDir = await readMaaDir('resource');
  const hotUpdateRoot = await readMaaDir('hot-update').catch(() => '');
  const dirs = hotUpdateRoot ? [resourceDir, join(hotUpdateRoot, 'resource')] : [resourceDir];
  return [...new Set(dirs.filter(dir => dir.length > 0))];
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

    for (const resourceDir of resourceDirs) {
      try {
        const versionFile = await readVersionFile(join(resourceDir, 'version.json'));
        const metadata = parseResourceVersion(versionFile.content);
        const timestamp = parseVersionTimestamp(metadata.lastUpdated);
        const info = buildResourceInfoFromMetadata(metadata, versionFile.modifiedAt, readAt);
        if (!selected || (timestamp ?? Number.NEGATIVE_INFINITY) >= (selected.timestamp ?? Number.NEGATIVE_INFINITY)) {
          selected = { info, timestamp };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (selected) return selected.info;
    throw lastError ?? new Error('无法读取 MAA 资源版本');
  }

  async function performUpdate(options: ResourceUpdateRunOptions): Promise<ResourceUpdateResult> {
    const output = await runHotUpdate(options);
    return {
      output,
      resource: await getResourceInfo()
    };
  }

  async function updateResources(options: ResourceUpdateRunOptions = {}): Promise<ResourceUpdateResult> {
    if (activeUpdate) return activeUpdate;

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

/** 解析 MaaCore 资源候选目录（基础资源与 hot-update 覆盖层）；解析失败时抛出。 */
export function getMaaResourceDirs(): Promise<string[]> {
  return readMaaResourceDirsFromCli();
}

/**
 * 同步 MAA 资源并返回更新后的信息。并发调用共享同一次更新；
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
