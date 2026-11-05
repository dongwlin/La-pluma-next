import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { getFallbackActivity, supportsFallbackClient } from './activityFallbackService.ts';
import { loadUserConfig, updateUserConfig } from './configStorageService.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { resolveGameZone } from './gameCalendar.ts';

const logger = createLogger('MaaService');

/** 正缓存 TTL：缩短后活动结束到重新查询的窗口更小，调用频率由 CLI 自身控制。 */
const ACTIVITY_CACHE_TTL = 10 * 60 * 1000;

/**
 * 负缓存 TTL：`none` 与解析不出活动代号的短结果只短暂复用。
 * 活动可能在下一分钟开始，因此不能沿用正缓存的十分钟。
 */
const NEGATIVE_ACTIVITY_CACHE_TTL = 60 * 1000;

/** 活动表最近确认时间的最大可信任年龄；超过后不能用“表里没有”断言当前没有活动。 */
const ACTIVITY_TABLE_MAX_AGE = 24 * 60 * 60 * 1000;

/** 活动读取的明确状态；`none` 不是失败，`stale`/`unavailable` 才是。 */
export type MaaActivityStatus = 'active' | 'none' | 'unavailable' | 'stale';

export interface MaaActivityFailure {
  source: 'maa' | 'penguin';
  message: string;
}

/** 单个进行中的活动；顶层活动字段与 `activities[0]` 保持同一份主活动投影。 */
export interface MaaActivityEntry {
  code: string | null;
  name: string | null;
  startTime: number | null;
  endTime: number | null;
  stages: string[];
  rerun: boolean;
}

/** 活动信息：无法确定的字段为 null，调用方不能把 null 当成已知值。 */
export interface MaaActivityInfo extends MaaActivityEntry {
  source: string | null;
  activities: MaaActivityEntry[];
}

/** `StageActivityV2.json` 的 sideStoryStage 条目：时间已折算为 UTC 毫秒。 */
export interface MaaSideStoryStage {
  key: string;
  name: string | null;
  tip: string | null;
  startTime: number | null;
  endTime: number | null;
  stages: string[];
  rerun: boolean;
}

export interface MaaActivitySnapshot extends MaaActivityInfo {
  status: MaaActivityStatus;
  clientType: string;
  lastSuccessAt: number | null;
  dataUpdatedAt: number | null;
  failure: MaaActivityFailure | null;
}

export interface CachedActivity extends MaaActivityInfo {
  timestamp: number;
  ttl: number;
}

export interface CachedNegativeActivity {
  timestamp: number;
  snapshot: MaaActivitySnapshot;
}

export interface MaaActivityTableState {
  exists: boolean;
  /** 活动表内容最后一次变化的时间；内容不变时不会前进。 */
  modifiedAt: number | null;
  /**
   * 最近一次与远端确认活动表一致的时间。maa-cli 的 ETag 热更新在 304 时只
   * touch 旁注文件 `StageActivityV2.json.etag`，所以取该文件 mtime 与内容
   * mtime 的较大者；没有旁注文件的旧缓存只有内容 mtime 可用。
   */
  checkedAt: number | null;
}

export interface MaaActivityRuntime {
  now?: () => number;
  cache?: Map<string, CachedActivity>;
  negativeCache?: Map<string, CachedNegativeActivity>;
  /** 在途读取；同一 clientType 的并发调用共享一次查询。 */
  inflight?: Map<string, Promise<MaaActivitySnapshot>>;
  runActivity?: (clientType: string) => Promise<{ stdout: string }>;
  readActivityTable?: () => Promise<MaaActivityTableState>;
  readSideStoryStages?: (clientType: string) => Promise<MaaSideStoryStage[]>;
  readFallback?: (clientType: string) => Promise<unknown>;
  supportsFallback?: (clientType: string) => boolean;
  loadConfig?: () => Promise<unknown>;
  saveConfig?: (payload: Record<string, unknown>) => Promise<unknown>;
}

export interface MaaActivityGroup {
  label: string;
  name: string;
  code: string | null;
  stages: string[];
}

export interface ParsedMaaActivityOutput {
  groups: MaaActivityGroup[];
  sawActivitySection: boolean;
  sawAnySection: boolean;
}

const activityCache = new Map<string, CachedActivity>();
const negativeActivityCache = new Map<string, CachedNegativeActivity>();
const activityRequests = new Map<string, Promise<MaaActivitySnapshot>>();

const ACTIVITY_SECTION_HEADER = 'Opening side story stages:';
const SECTION_HEADER_PATTERN = /^Opening\s+[A-Za-z][A-Za-z0-9 ]*:\s*$/;
const GROUP_LINE_PATTERN = /^-\s+(.+?)\s*$/;
const STAGE_LINE_PATTERN = /^\s+-\s+(.+?)\s*$/;
const STAGE_PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,7})-\d/;
const QUOTED_NAME_PATTERN = /[「『]([^」』]+)[」』]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RERUN_MARKER_PATTERN = /复刻|復刻|reopen|rerun|재개방/i;

function marksRerun(...values: Array<string | null | undefined>): boolean {
  return values.some(value => typeof value === 'string' && RERUN_MARKER_PATTERN.test(value));
}

function readActivityStages(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((stage): stage is string => typeof stage === 'string' && stage.length > 0)
    : [];
}

function normalizeActivityEntry(value: unknown): MaaActivityEntry | null {
  if (!isRecord(value)) return null;
  const code = typeof value.code === 'string' && value.code ? value.code : null;
  const name = typeof value.name === 'string' ? value.name : null;
  const stages = readActivityStages(value.stages);
  if (!code && !name && stages.length === 0) return null;
  return {
    code,
    name,
    startTime: typeof value.startTime === 'number' && Number.isFinite(value.startTime) ? value.startTime : null,
    endTime: typeof value.endTime === 'number' && Number.isFinite(value.endTime) ? value.endTime : null,
    stages,
    rerun: value.rerun === true
  };
}

function normalizeActivityInfo(value: unknown): MaaActivityInfo | null {
  if (!isRecord(value) || typeof value.code !== 'string' || !value.code) return null;
  const primary: MaaActivityEntry = {
    code: value.code,
    name: typeof value.name === 'string' ? value.name : null,
    startTime: typeof value.startTime === 'number' && Number.isFinite(value.startTime) ? value.startTime : null,
    endTime: typeof value.endTime === 'number' && Number.isFinite(value.endTime) ? value.endTime : null,
    stages: readActivityStages(value.stages),
    rerun: value.rerun === true
  };
  const storedActivities = Array.isArray(value.activities)
    ? value.activities
      .map(normalizeActivityEntry)
      .filter((entry): entry is MaaActivityEntry => entry !== null)
    : [];
  const activities = storedActivities.length > 0
    ? storedActivities
    : [primary];
  return {
    ...primary,
    source: typeof value.source === 'string' ? value.source : null,
    rerun: typeof value.rerun === 'boolean' ? value.rerun : activities.some(entry => entry.rerun),
    activities
  };
}

function readCachedActivity(value: unknown): CachedActivity | null {
  const info = normalizeActivityInfo(value);
  if (!info || !isRecord(value)) return null;
  const timestamp = typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
    ? value.timestamp
    : null;
  if (timestamp === null) return null;
  const storedTtl = typeof value.ttl === 'number' && Number.isFinite(value.ttl) && value.ttl > 0
    ? value.ttl
    : ACTIVITY_CACHE_TTL;
  return { ...info, timestamp, ttl: Math.min(storedTtl, ACTIVITY_CACHE_TTL) };
}

function readFreshCachedActivity(cached: CachedActivity, now: number): MaaActivityInfo | null {
  if (!cached.code) return null;
  const ttlExpiresAt = cached.timestamp + Math.min(cached.ttl || ACTIVITY_CACHE_TTL, ACTIVITY_CACHE_TTL);
  const expiresAt = cached.endTime !== null
    ? Math.min(ttlExpiresAt, cached.endTime)
    : ttlExpiresAt;
  if (now >= expiresAt) return null;
  return {
    code: cached.code,
    name: cached.name,
    source: cached.source,
    startTime: cached.startTime,
    endTime: cached.endTime,
    stages: [...cached.stages],
    rerun: cached.rerun,
    activities: cached.activities.map(entry => ({ ...entry, stages: [...entry.stages] }))
  };
}

function newerCache(left: CachedActivity | null, right: CachedActivity | null): CachedActivity | null {
  if (!left) return right;
  if (!right) return left;
  return right.timestamp > left.timestamp ? right : left;
}

/**
 * 按活动组解析 `maa activity` 文本。
 *
 * 段头是格式守卫：只解析 `Opening side story stages:` 之后的组；其他
 * `Opening ...:` 段立即结束活动段。组名优先取「」/『』内文本；代号只从
 * 同组关卡推导，避免第一组名称配上第二组代号。主线数字关卡不产生代号。
 */
export function parseMaaActivityGroups(output: string): ParsedMaaActivityOutput {
  const groups: MaaActivityGroup[] = [];
  let sawActivitySection = false;
  let sawAnySection = false;
  let inActivitySection = false;
  let current: MaaActivityGroup | null = null;

  for (const line of String(output ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (SECTION_HEADER_PATTERN.test(trimmed)) {
      sawAnySection = true;
      inActivitySection = trimmed === ACTIVITY_SECTION_HEADER;
      if (inActivitySection) sawActivitySection = true;
      current = null;
      continue;
    }
    if (!inActivitySection) continue;

    const groupMatch = GROUP_LINE_PATTERN.exec(line);
    if (groupMatch?.[1]) {
      const label = groupMatch[1];
      const nameMatch = QUOTED_NAME_PATTERN.exec(label);
      current = {
        label,
        name: nameMatch?.[1]?.trim() || label,
        code: null,
        stages: []
      };
      groups.push(current);
      continue;
    }

    const stageMatch = STAGE_LINE_PATTERN.exec(line);
    if (stageMatch?.[1] && current) {
      const stage = stageMatch[1].split(':', 1)[0]?.trim() || '';
      if (stage) current.stages.push(stage);
    }
  }

  return {
    groups: groups.map(group => ({ ...group, code: deriveActivityCode(group.stages) })),
    sawActivitySection,
    sawAnySection
  };
}

/** 组内出现次数最多的关卡前缀；前置锚点保证 `ABCD-8` 不会被截成 `BCD`。 */
function deriveActivityCode(stages: readonly string[]): string | null {
  const counts = new Map<string, { count: number; order: number }>();
  stages.forEach((stage, order) => {
    const match = STAGE_PREFIX_PATTERN.exec(stage);
    if (!match?.[1]) return;
    const prefix = match[1].toUpperCase();
    const existing = counts.get(prefix);
    if (existing) existing.count += 1;
    else counts.set(prefix, { count: 1, order });
  });

  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].order - right[1].order)[0]?.[0] ?? null;
}

async function readMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 读取缓存目录中的活动表状态；不启动 CLI，目录由调用方解析。
 *
 * `modifiedAt` 是活动表内容 mtime，内容不变时不会前进。maa-cli 的热更新在
 * 304 时只 touch ETag 旁注文件，因此“最近确认”取旁注文件与内容 mtime 的
 * 较大者；没有旁注文件的旧缓存回落到内容 mtime，保持原先的保守判定。
 */
export async function readActivityTableState(cacheDir: string): Promise<MaaActivityTableState> {
  const tablePath = join(cacheDir, 'StageActivityV2.json');
  const modifiedAt = await readMtimeMs(tablePath);
  if (modifiedAt === null) return { exists: false, modifiedAt: null, checkedAt: null };
  const etagCheckedAt = await readMtimeMs(`${tablePath}.etag`);
  return {
    exists: true,
    modifiedAt,
    checkedAt: Math.max(modifiedAt, etagCheckedAt ?? modifiedAt)
  };
}

/**
 * MAA 缓存目录：显式 `MAA_CACHE_DIR` 优先，与任务缓存的解析顺序一致。
 *
 * `maa dir cache` 在进程生命周期内结果稳定；这里缓存进行中的查询，让并发
 * 调用共享同一次 CLI 查询，失败时清空缓存以便下一次重试。目录为空也是
 * 有效结果，由活动表读取按“不存在”处理。
 */
let maaCacheDirRequest: { configured: string | null; promise: Promise<string | null> } | null = null;

function resolveMaaCacheDir(): Promise<string | null> {
  const configured = process.env.MAA_CACHE_DIR?.trim() || null;
  if (maaCacheDirRequest?.configured === configured) return maaCacheDirRequest.promise;

  let request: Promise<string | null>;
  request = (async () => {
    if (configured) return configured;
    const result = await execMaaCommand('dir', ['cache'], null, null, false, true);
    return result.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
  })().catch(error => {
    if (maaCacheDirRequest?.promise === request) maaCacheDirRequest = null;
    throw error;
  });
  maaCacheDirRequest = { configured, promise: request };
  return request;
}

/** 活动表状态读取只解析一次缓存目录，不再为每次轮询启动 `maa dir cache`。 */
async function readMaaActivityTable(): Promise<MaaActivityTableState> {
  const cacheDir = await resolveMaaCacheDir();
  if (!cacheDir) return { exists: false, modifiedAt: null, checkedAt: null };
  return readActivityTableState(cacheDir);
}

export interface ResourceCollectionWindow {
  startTime: number;
  endTime: number;
}

export interface ResourceCollectionRuntime {
  now?: () => number;
  readWindow?: (clientType: string) => Promise<ResourceCollectionWindow | null>;
  cache?: Map<string, CachedResourceCollectionWindow>;
  inflight?: Map<string, Promise<ResourceCollectionWindow | null>>;
}

export interface CachedResourceCollectionWindow {
  timestamp: number;
  window: ResourceCollectionWindow | null;
  failed: boolean;
}

/** 窗口缓存 TTL：总览轮询与逐关卡执行检查不需要每次都启动 CLI。 */
const RESOURCE_COLLECTION_CACHE_TTL = 60 * 1000;

/** 读取失败只短暂退避，活动表恢复后下一次轮询即可重新读取。 */
const RESOURCE_COLLECTION_FAILURE_TTL = 5 * 1000;

const resourceCollectionCache = new Map<string, CachedResourceCollectionWindow>();
const resourceCollectionRequests = new Map<string, Promise<ResourceCollectionWindow | null>>();

const ACTIVITY_DATE_TIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 解析活动表时间：`yyyy/MM/dd HH:mm:ss` 是服务区当地时刻，减去 `TimeZone`
 * 小时后得到 UTC 时间戳（与上游 StageManager 的折算一致）。
 */
export function parseActivityTimestamp(value: unknown, timeZone: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ACTIVITY_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  const offsetHours = typeof timeZone === 'number' && Number.isFinite(timeZone) ? timeZone : 0;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])
  ) - offsetHours * 60 * 60 * 1000;
}

export function parseResourceCollectionWindow(entry: unknown): ResourceCollectionWindow | null {
  if (!isRecord(entry)) return null;
  const startTime = parseActivityTimestamp(entry.UtcStartTime, entry.TimeZone);
  const endTime = parseActivityTimestamp(entry.UtcExpireTime, entry.TimeZone);
  if (startTime === null || endTime === null || endTime <= startTime) return null;
  return { startTime, endTime };
}

function readSideStoryStageValue(stage: unknown): string | null {
  if (!isRecord(stage)) return null;
  const value = typeof stage.Value === 'string'
    ? stage.Value
    : typeof stage.Display === 'string' ? stage.Display : '';
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 从活动表解析指定服务区的 sideStoryStage。
 *
 * 条目按表内顺序返回；`Stages[].Value` 是实际关卡代号，缺失时回落到
 * `Display`。复刻同时看表键（`SSReopen`）、标题/提示与服务区译名
 * （`复刻`、`Rerun`、`재개방`），避免只依赖单一文案。
 */
export function parseSideStoryStages(table: unknown, clientType: string): MaaSideStoryStage[] {
  if (!isRecord(table)) return [];
  const clientNode = table[activityTableClientKey(clientType)];
  if (!isRecord(clientNode) || !isRecord(clientNode.sideStoryStage)) return [];
  const entries: MaaSideStoryStage[] = [];
  for (const [key, rawEntry] of Object.entries(clientNode.sideStoryStage)) {
    if (!isRecord(rawEntry)) continue;
    const activity = isRecord(rawEntry.Activity) ? rawEntry.Activity : {};
    const name = typeof activity.StageName === 'string' && activity.StageName.trim()
      ? activity.StageName.trim()
      : null;
    const tip = typeof activity.Tip === 'string' && activity.Tip.trim() ? activity.Tip.trim() : null;
    const stages = Array.isArray(rawEntry.Stages)
      ? [...new Set(rawEntry.Stages.map(readSideStoryStageValue)
        .filter((stage): stage is string => stage !== null))]
      : [];
    entries.push({
      key,
      name,
      tip,
      startTime: parseActivityTimestamp(activity.UtcStartTime, activity.TimeZone),
      endTime: parseActivityTimestamp(activity.UtcExpireTime, activity.TimeZone),
      stages,
      rerun: key.toUpperCase() === 'SSREOPEN' || marksRerun(key, name, tip, ...stages)
    });
  }
  return entries;
}

/** 活动表没有独立的 Bilibili 数据，繁中按国服服务区窗口读取。 */
function activityTableClientKey(clientType: string): string {
  const normalized = resolveGameZone(clientType).clientType;
  return normalized === 'Bilibili' ? 'Official' : normalized;
}

async function readMaaSideStoryStages(clientType: string): Promise<MaaSideStoryStage[]> {
  const cacheDir = await resolveMaaCacheDir();
  if (!cacheDir) return [];
  const table: unknown = JSON.parse(await readFile(join(cacheDir, 'StageActivityV2.json'), 'utf-8'));
  return parseSideStoryStages(table, clientType);
}

async function readResourceCollectionWindow(clientType: string): Promise<ResourceCollectionWindow | null> {
  const cacheDir = await resolveMaaCacheDir();
  if (!cacheDir) return null;
  const table: unknown = JSON.parse(await readFile(join(cacheDir, 'StageActivityV2.json'), 'utf-8'));
  if (!isRecord(table) || !isRecord(table[clientType])) return null;
  return parseResourceCollectionWindow(table[clientType].resourceCollection);
}

interface ResourceCollectionReadOptions {
  now: number;
  readWindow: (clientType: string) => Promise<ResourceCollectionWindow | null>;
  cache: Map<string, CachedResourceCollectionWindow>;
  inflight: Map<string, Promise<ResourceCollectionWindow | null>>;
}

/**
 * 带短缓存与单飞的窗口读取。
 *
 * 成功结果（包括“表里没有窗口”）缓存 60 秒；读取失败只写 5 秒失败缓存，
 * 不把 `window: null` 当成一分钟内的确定答案。同一服务区的并发首次调用
 * 共享同一次读取，避免同时启动多个 CLI。
 */
async function readCachedResourceCollectionWindow(
  clientType: string,
  { now, readWindow, cache, inflight }: ResourceCollectionReadOptions
): Promise<ResourceCollectionWindow | null> {
  const cached = cache.get(clientType);
  if (cached) {
    const ttl = cached.failed ? RESOURCE_COLLECTION_FAILURE_TTL : RESOURCE_COLLECTION_CACHE_TTL;
    if (now - cached.timestamp < ttl) return cached.window;
  }

  const pending = inflight.get(clientType);
  if (pending) return pending;

  let request: Promise<ResourceCollectionWindow | null>;
  request = Promise.resolve()
    .then(() => readWindow(clientType))
    .then(
      window => {
        cache.set(clientType, { timestamp: now, window, failed: false });
        return window;
      },
      error => {
        logger.debug('读取资源全开放窗口失败，按周表判定关卡开放', {
          clientType,
          error: errorMessageOf(error)
        });
        cache.set(clientType, { timestamp: now, window: null, failed: true });
        return null;
      }
    )
    .finally(() => {
      if (inflight.get(clientType) === request) inflight.delete(clientType);
    });
  inflight.set(clientType, request);
  return request;
}

/**
 * 客户端服务区是否处于资源收集全开放活动。
 *
 * 活动表不可读时返回 false：未知状态不能当作全开放，宁可沿用周表。
 */
export async function isResourceCollectionOpen(
  clientType: string = DEFAULT_CLIENT_TYPE,
  runtime: ResourceCollectionRuntime = {}
): Promise<boolean> {
  const now = (runtime.now ?? Date.now)();
  const tableClientType = activityTableClientKey(clientType);
  const window = await readCachedResourceCollectionWindow(tableClientType, {
    now,
    readWindow: runtime.readWindow ?? readResourceCollectionWindow,
    cache: runtime.cache ?? resourceCollectionCache,
    inflight: runtime.inflight ?? resourceCollectionRequests
  });
  if (!window) return false;
  return now >= window.startTime && now <= window.endTime;
}

/** 持久化保存把当前服务区条目合并进已有记录，不再整份覆盖其他服务区。 */
async function saveActivityConfig(payload: Record<string, unknown>): Promise<unknown> {
  const result = await updateUserConfig('activity-cache', current => ({
    ...(isRecord(current) ? current : {}),
    ...payload
  }));
  if (!result.success) throw new Error(result.message || '保存活动缓存失败');
  return result;
}

const defaultRuntime: Required<MaaActivityRuntime> = {
  now: Date.now,
  cache: activityCache,
  negativeCache: negativeActivityCache,
  inflight: activityRequests,
  runActivity: clientType => execMaaCommand('activity', [clientType], null, null, false, true),
  readActivityTable: readMaaActivityTable,
  readSideStoryStages: readMaaSideStoryStages,
  readFallback: clientType => getFallbackActivity(clientType),
  supportsFallback: supportsFallbackClient,
  loadConfig: async () => {
    const result = await loadUserConfig('activity-cache');
    return result.success ? result.data : null;
  },
  saveConfig: saveActivityConfig
};

/**
 * 清理进程内活动缓存，供测试用例之间隔离；生产运行不调用。
 * 活动查询依赖进程级目录与短缓存，测试需要显式的重置边界。
 */
export function resetMaaActivityCachesForTests(): void {
  activityCache.clear();
  negativeActivityCache.clear();
  activityRequests.clear();
  maaCacheDirRequest = null;
  resourceCollectionCache.clear();
  resourceCollectionRequests.clear();
}

/**
 * DTO 时间戳只接受安全整数：文件系统 mtime 是浮点毫秒，服务端缓存的时间戳
 * 也可能带小数；快照边界统一取整，避免跨端契约在客户端被判为非法载荷。
 */
function toDtoTimestamp(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

function toDtoActivityEntry(entry: MaaActivityEntry): MaaActivityEntry {
  return {
    ...entry,
    startTime: toDtoTimestamp(entry.startTime),
    endTime: toDtoTimestamp(entry.endTime),
    stages: [...entry.stages]
  };
}

function snapshotOf(
  clientType: string,
  info: MaaActivityInfo,
  status: MaaActivityStatus,
  lastSuccessAt: number | null,
  dataUpdatedAt: number | null,
  failure: MaaActivityFailure | null
): MaaActivitySnapshot {
  return {
    ...info,
    startTime: toDtoTimestamp(info.startTime),
    endTime: toDtoTimestamp(info.endTime),
    activities: info.activities.map(toDtoActivityEntry),
    status,
    clientType,
    lastSuccessAt: toDtoTimestamp(lastSuccessAt),
    dataUpdatedAt: toDtoTimestamp(dataUpdatedAt),
    failure
  };
}

function emptyActivityInfo(source: string | null = null): MaaActivityInfo {
  return {
    code: null,
    name: null,
    source,
    startTime: null,
    endTime: null,
    stages: [],
    rerun: false,
    activities: []
  };
}

function findSideStoryStage(
  group: MaaActivityGroup,
  entries: readonly MaaSideStoryStage[],
  usedKeys: ReadonlySet<string>
): MaaSideStoryStage | null {
  const code = group.code?.toUpperCase() ?? null;
  const candidates = entries.filter(entry => !usedKeys.has(entry.key));
  const stagePrefixMatch = code
    ? candidates.find(entry => entry.key.toUpperCase() === code
      || entry.stages.some(stage => stage.toUpperCase().startsWith(`${code}-`)))
    : undefined;
  if (stagePrefixMatch) return stagePrefixMatch;
  return candidates.find(entry => {
    if (!entry.name) return false;
    return entry.name === group.name
      || entry.tip?.includes(group.name) === true
      || group.label.includes(entry.name);
  }) ?? null;
}

function toActivityEntry(
  group: MaaActivityGroup,
  stageEntry: MaaSideStoryStage | null
): MaaActivityEntry {
  return {
    code: group.code,
    name: group.name || stageEntry?.name || null,
    startTime: stageEntry?.startTime ?? null,
    endTime: stageEntry?.endTime ?? null,
    stages: stageEntry?.stages.length ? stageEntry.stages : group.stages,
    rerun: stageEntry?.rerun === true || marksRerun(group.label, group.name)
  };
}

function buildMaaActivityInfo(
  groups: readonly MaaActivityGroup[],
  sideStoryStages: readonly MaaSideStoryStage[]
): MaaActivityInfo {
  const usedKeys = new Set<string>();
  const activities = groups.map(group => {
    const stageEntry = findSideStoryStage(group, sideStoryStages, usedKeys);
    if (stageEntry) usedKeys.add(stageEntry.key);
    return toActivityEntry(group, stageEntry);
  });
  const primary = activities.find(activity => activity.code) ?? activities[0] ?? emptyActivityInfo('maa');
  return {
    ...primary,
    source: 'maa',
    rerun: activities.some(activity => activity.rerun),
    activities
  };
}

function combineFailures(
  maaFailure: MaaActivityFailure | null,
  fallbackFailure: MaaActivityFailure | null
): MaaActivityFailure | null {
  if (maaFailure && fallbackFailure) {
    return {
      source: maaFailure.source,
      message: `${maaFailure.message}；${fallbackFailure.message}`
    };
  }
  return maaFailure ?? fallbackFailure;
}

/**
 * 读取当前活动快照。
 *
 * 同一 `clientType` 的并发调用共享同一次读取，避免轮询突发重复启动 CLI。
 * 读取顺序：新鲜内存/持久化缓存 → 短负缓存 → `maa activity` → 备用数据源。
 * 只有活动表存在且未过期时，maa 的空结果才能作为 `none`；否则继续查备用源。
 * 所有来源失败时，旧的成功缓存降级为 `stale`，没有旧数据才是 `unavailable`。
 */
export async function getCurrentActivity(
  clientType: string = DEFAULT_CLIENT_TYPE,
  overrides: MaaActivityRuntime = {}
): Promise<MaaActivitySnapshot> {
  const runtime = { ...defaultRuntime, ...overrides };
  const inflight = runtime.inflight;
  const pending = inflight.get(clientType);
  if (pending) return pending;

  let request: Promise<MaaActivitySnapshot>;
  request = loadCurrentActivity(clientType, runtime).finally(() => {
    if (inflight.get(clientType) === request) inflight.delete(clientType);
  });
  inflight.set(clientType, request);
  return request;
}

async function loadCurrentActivity(
  clientType: string,
  runtime: Required<MaaActivityRuntime>
): Promise<MaaActivitySnapshot> {
  const now = runtime.now();
  const cache = runtime.cache;

  const memoryCandidate = cache.get(clientType) ?? null;
  const memoryFresh = memoryCandidate ? readFreshCachedActivity(memoryCandidate, now) : null;
  if (memoryCandidate && memoryFresh) {
    logger.debug('使用缓存的活动信息', {
      clientType, code: memoryFresh.code, name: memoryFresh.name, source: memoryFresh.source
    });
    return snapshotOf(clientType, memoryFresh, 'active', memoryCandidate.timestamp, null, null);
  }

  let persistedRecord: Record<string, unknown> | null = null;
  let persistedCandidate: CachedActivity | null = null;
  try {
    const loaded = await runtime.loadConfig();
    persistedRecord = isRecord(loaded) ? loaded : null;
    persistedCandidate = readCachedActivity(persistedRecord?.[clientType]);
  } catch (error) {
    logger.warn('读取持久化活动缓存失败', { clientType, error: errorMessageOf(error) });
  }

  const newestCandidate = newerCache(memoryCandidate, persistedCandidate);
  const newestFresh = newestCandidate ? readFreshCachedActivity(newestCandidate, now) : null;
  if (newestFresh && newestCandidate) {
    cache.set(clientType, newestCandidate);
    logger.debug('使用持久化活动缓存', {
      clientType, code: newestFresh.code, name: newestFresh.name, source: newestFresh.source
    });
    return snapshotOf(clientType, newestFresh, 'active', newestCandidate.timestamp, null, null);
  }
  if (newestCandidate) cache.delete(clientType);

  const negative = runtime.negativeCache.get(clientType);
  if (negative && now - negative.timestamp < NEGATIVE_ACTIVITY_CACHE_TTL) {
    logger.debug('使用短负缓存的活动结果', {
      clientType, status: negative.snapshot.status, source: negative.snapshot.source
    });
    return { ...negative.snapshot };
  }
  if (negative) runtime.negativeCache.delete(clientType);

  let maaFailure: MaaActivityFailure | null = null;
  let table: MaaActivityTableState | null = null;
  try {
    const result = await runtime.runActivity(clientType);
    const output = String(result.stdout ?? '');
    const parsed = parseMaaActivityGroups(output);
    logger.debug('maa activity 原始输出', { output });

    if (parsed.groups.length > 0) {
      try {
        table = await runtime.readActivityTable();
      } catch {
        table = null;
      }
      let sideStoryStages: MaaSideStoryStage[] = [];
      try {
        sideStoryStages = await runtime.readSideStoryStages(clientType);
      } catch (error) {
        logger.debug('读取 sideStoryStage 失败，保留 CLI 解析结果', {
          clientType,
          error: errorMessageOf(error)
        });
      }
      const activity = buildMaaActivityInfo(parsed.groups, sideStoryStages);
      const snapshot = snapshotOf(clientType, activity, 'active', now, table?.modifiedAt ?? null, null);
      // 解析不出代号时无法写入正缓存；用短负缓存避免每次轮询重复启动 CLI。
      if (activity.code) await persistActivity(runtime, persistedRecord, clientType, activity, now);
      else rememberNegativeActivity(runtime, clientType, snapshot, now);
      return snapshot;
    }

    if (output.trim() && !parsed.sawAnySection) {
      maaFailure = { source: 'maa', message: '无法识别 MAA 活动输出格式' };
    } else {
      try {
        table = await runtime.readActivityTable();
      } catch (error) {
        maaFailure = {
          source: 'maa',
          message: `无法读取 MAA 活动数据表: ${errorMessageOf(error)}`
        };
      }
      if (!maaFailure) {
        const checkedAt = table?.checkedAt ?? table?.modifiedAt ?? null;
        if (!table?.exists || checkedAt === null) {
          maaFailure = { source: 'maa', message: 'MAA 活动数据表不存在或不可读' };
        } else if (now - checkedAt > ACTIVITY_TABLE_MAX_AGE) {
          maaFailure = { source: 'maa', message: 'MAA 活动数据表已超过 24 小时未更新' };
        } else {
          const activity = emptyActivityInfo('maa');
          const snapshot = snapshotOf(clientType, activity, 'none', now, table.modifiedAt, null);
          rememberNegativeActivity(runtime, clientType, snapshot, now);
          return snapshot;
        }
      }
    }
  } catch (error) {
    maaFailure = {
      source: 'maa',
      message: `MAA 活动查询失败: ${errorMessageOf(error)}`
    };
  }

  let fallbackFailure: MaaActivityFailure | null = null;
  if (!runtime.supportsFallback(clientType)) {
    fallbackFailure = {
      source: 'penguin',
      message: `备用活动数据源不支持 ${clientType}`
    };
  } else {
    try {
      const fallbackActivity = normalizeActivityInfo(await runtime.readFallback(clientType));
      if (fallbackActivity?.code) {
        logger.info('从备用数据源获取到活动信息', fallbackActivity);
        await persistActivity(runtime, persistedRecord, clientType, fallbackActivity, now);
        return snapshotOf(clientType, fallbackActivity, 'active', now, now, null);
      }
      const snapshot = snapshotOf(clientType, emptyActivityInfo('penguin'), 'none', now, now, null);
      rememberNegativeActivity(runtime, clientType, snapshot, now);
      return snapshot;
    } catch (error) {
      fallbackFailure = {
        source: 'penguin',
        message: `备用活动数据源不可用: ${errorMessageOf(error)}`
      };
    }
  }

  const failure = combineFailures(maaFailure, fallbackFailure);
  if (newestCandidate) {
    logger.warn('活动来源全部失败，返回上次成功的缓存', { clientType, failure });
    return snapshotOf(
      clientType,
      {
        code: newestCandidate.code,
        name: newestCandidate.name,
        source: newestCandidate.source,
        startTime: newestCandidate.startTime,
        endTime: newestCandidate.endTime,
        stages: [...newestCandidate.stages],
        rerun: newestCandidate.rerun,
        activities: newestCandidate.activities.map(entry => ({ ...entry, stages: [...entry.stages] }))
      },
      'stale',
      newestCandidate.timestamp,
      null,
      failure
    );
  }

  logger.warn('无法获取活动信息', { clientType, failure });
  return snapshotOf(clientType, emptyActivityInfo(), 'unavailable', null, null, failure);
}

function rememberNegativeActivity(
  runtime: Required<MaaActivityRuntime>,
  clientType: string,
  snapshot: MaaActivitySnapshot,
  now: number
): void {
  if (snapshot.code) return;
  runtime.negativeCache.set(clientType, { timestamp: now, snapshot });
}

async function persistActivity(
  runtime: Required<MaaActivityRuntime>,
  persistedRecord: Record<string, unknown> | null,
  clientType: string,
  activity: MaaActivityInfo,
  now: number
): Promise<void> {
  if (!activity.code) return;
  const cached: CachedActivity = {
    ...activity,
    timestamp: now,
    ttl: ACTIVITY_CACHE_TTL
  };
  runtime.cache.set(clientType, cached);
  runtime.negativeCache.delete(clientType);
  try {
    await runtime.saveConfig({
      ...(persistedRecord ?? {}),
      [clientType]: cached
    });
  } catch (error) {
    logger.warn('保存活动缓存失败', { clientType, error: errorMessageOf(error) });
  }
}

export async function replaceActivityCode(stage: unknown, clientType: string = DEFAULT_CLIENT_TYPE): Promise<unknown> {
  if (!stage || typeof stage !== 'string') {
    return stage;
  }

  const hdMatch = stage.match(/^hd-(\d+)$/i);
  if (!hdMatch) {
    return stage;
  }

  const stageNumber = hdMatch[1];
  const activityInfo = await getCurrentActivity(clientType);

  if (activityInfo.code) {
    const realStage = `${activityInfo.code}-${stageNumber}`;
    logger.debug('关卡代号替换', { original: stage, replaced: realStage });
    return realStage;
  }

  logger.warn('无法获取活动代号，保持原关卡代号', { stage });
  return stage;
}
