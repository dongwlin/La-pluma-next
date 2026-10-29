import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { getFallbackActivity, supportsFallbackClient } from './activityFallbackService.ts';
import { loadUserConfig, updateUserConfig } from './configStorageService.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { resolveGameZone } from './gameCalendar.ts';

/**
 * 当前活动查询与关卡代号替换。
 *
 * - 读取结果是一份带状态的快照：`active`/`none` 表示来源给出了肯定答案，
 *   `stale` 表示所有来源都失败但保留了上次成功的数据，`unavailable`
 *   表示既没有可确认的结果也没有旧数据。
 * - 活动信息先读内存缓存，再读用户配置中的 `activity-cache`，最后查
 *   `maa activity`；只有 maa 无法给出肯定答案时才查备用数据源。
 * - CLI 的空输出不能单独证明“没有活动”：还要确认 MAA 活动表存在且在 24 小时内
 *   与远端确认过（内容 mtime 只在表变化时前进，确认时间取 ETag 旁注文件）。
 * - 资源收集全开放窗口同读 MAA 活动表的 `resourceCollection` 节点：不可读时
 *   按“未开放”处理，关卡开放判定沿用周表。
 * - 持久化沿用 configStorageService 的受控类型，读改写合并其他服务区条目，
 *   不在这里另写文件；保存失败只告警，不否决本次读取。
 * - MAA 活动查询是非设备变更命令，不持有执行租约；本模块不保存任务状态。
 */

const logger = createLogger('MaaService');

/** 正缓存 TTL：缩短后活动结束到重新查询的窗口更小，调用频率由 CLI 自身控制。 */
const ACTIVITY_CACHE_TTL = 10 * 60 * 1000;

/** 活动表最近确认时间的最大可信任年龄；超过后不能用“表里没有”断言当前没有活动。 */
const ACTIVITY_TABLE_MAX_AGE = 24 * 60 * 60 * 1000;

/** 活动读取的明确状态；`none` 不是失败，`stale`/`unavailable` 才是。 */
export type MaaActivityStatus = 'active' | 'none' | 'unavailable' | 'stale';

/** 某个来源失败的原因；多个来源失败时合并到同一条 message 中。 */
export interface MaaActivityFailure {
  source: 'maa' | 'penguin';
  message: string;
}

/** 活动信息：无法确定的字段为 null，调用方不能把 null 当成已知值。 */
export interface MaaActivityInfo {
  code: string | null;
  name: string | null;
  source: string | null;
  startTime: number | null;
  endTime: number | null;
  stages: string[];
}

/** 活动读取结果：在活动信息之外显式记录状态、来源时间与失败原因。 */
export interface MaaActivitySnapshot extends MaaActivityInfo {
  status: MaaActivityStatus;
  clientType: string;
  lastSuccessAt: number | null;
  dataUpdatedAt: number | null;
  failure: MaaActivityFailure | null;
}

/** 内存与持久化缓存条目：活动信息加写入时间与 TTL。 */
export interface CachedActivity extends MaaActivityInfo {
  timestamp: number;
  ttl: number;
}

/** MAA 活动表在缓存目录中的存在性、内容修改时间与最近确认时间。 */
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

/** 读取依赖端口；缺省实现调用真实 CLI、文件系统与配置存储，测试可整体替换。 */
export interface MaaActivityRuntime {
  now?: () => number;
  cache?: Map<string, CachedActivity>;
  runActivity?: (clientType: string) => Promise<{ stdout: string }>;
  readActivityTable?: () => Promise<MaaActivityTableState>;
  readFallback?: (clientType: string) => Promise<unknown>;
  supportsFallback?: (clientType: string) => boolean;
  loadConfig?: () => Promise<unknown>;
  saveConfig?: (payload: Record<string, unknown>) => Promise<unknown>;
}

/** 解析出的活动组：名称与代号来自同一组关卡，避免跨组借用。 */
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

/** 活动信息来源（MAA、备用数据源或缓存）逐字段收窄；没 code 视为无效。 */
function normalizeActivityInfo(value: unknown): MaaActivityInfo | null {
  if (!isRecord(value) || typeof value.code !== 'string' || !value.code) return null;
  return {
    code: value.code,
    name: typeof value.name === 'string' ? value.name : null,
    source: typeof value.source === 'string' ? value.source : null,
    startTime: typeof value.startTime === 'number' && Number.isFinite(value.startTime) ? value.startTime : null,
    endTime: typeof value.endTime === 'number' && Number.isFinite(value.endTime) ? value.endTime : null,
    stages: Array.isArray(value.stages)
      ? value.stages.filter((stage): stage is string => typeof stage === 'string')
      : []
  };
}

/** `activity-cache` 中的单条记录：必须带 code 与写入时间，旧 TTL 夹到当前上限。 */
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

/** 缓存条目是否仍可用于 `active`：TTL 与活动结束时间取较早者。 */
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
    stages: cached.stages
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

/** 单个路径的修改时间（毫秒）；文件不存在或不可读时返回 null。 */
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

/** `maa dir cache` 的输出只取首行；空目录也照原样返回，由 stat 判定是否存在。 */
async function readMaaActivityTable(): Promise<MaaActivityTableState> {
  const result = await execMaaCommand('dir', ['cache'], null, null, false, true);
  const cacheDir = result.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!cacheDir) return { exists: false, modifiedAt: null, checkedAt: null };
  return readActivityTableState(cacheDir);
}

/** 资源收集全开放窗口；时间为 UTC 毫秒时间戳，闭区间。 */
export interface ResourceCollectionWindow {
  startTime: number;
  endTime: number;
}

/** 资源全开放读取端口；缺省读取 MAA 缓存的活动表，测试可整体替换。 */
export interface ResourceCollectionRuntime {
  now?: () => number;
  readWindow?: (clientType: string) => Promise<ResourceCollectionWindow | null>;
}

/** 窗口缓存 TTL：总览轮询与逐关卡执行检查不需要每次都启动 CLI。 */
const RESOURCE_COLLECTION_CACHE_TTL = 60 * 1000;

const resourceCollectionCache = new Map<string, { timestamp: number; window: ResourceCollectionWindow | null }>();

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

/** 从活动表的 `resourceCollection` 节点解析窗口；缺字段或区间倒置时返回 null。 */
export function parseResourceCollectionWindow(entry: unknown): ResourceCollectionWindow | null {
  if (!isRecord(entry)) return null;
  const startTime = parseActivityTimestamp(entry.UtcStartTime, entry.TimeZone);
  const endTime = parseActivityTimestamp(entry.UtcExpireTime, entry.TimeZone);
  if (startTime === null || endTime === null || endTime <= startTime) return null;
  return { startTime, endTime };
}

/** 活动表没有独立的 Bilibili 数据，繁中按国服服务区窗口读取。 */
function activityTableClientKey(clientType: string): string {
  const normalized = resolveGameZone(clientType).clientType;
  return normalized === 'Bilibili' ? 'Official' : normalized;
}

/** MAA 缓存目录：显式 `MAA_CACHE_DIR` 优先，与任务缓存的解析顺序一致。 */
async function readMaaCacheDir(): Promise<string | null> {
  const configured = process.env.MAA_CACHE_DIR?.trim();
  if (configured) return configured;
  const result = await execMaaCommand('dir', ['cache'], null, null, false, true);
  return result.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
}

async function readResourceCollectionWindow(clientType: string): Promise<ResourceCollectionWindow | null> {
  const cacheDir = await readMaaCacheDir();
  if (!cacheDir) return null;
  const table: unknown = JSON.parse(await readFile(join(cacheDir, 'StageActivityV2.json'), 'utf-8'));
  if (!isRecord(table) || !isRecord(table[clientType])) return null;
  return parseResourceCollectionWindow(table[clientType].resourceCollection);
}

async function readCachedResourceCollectionWindow(clientType: string): Promise<ResourceCollectionWindow | null> {
  const timestamp = Date.now();
  const cached = resourceCollectionCache.get(clientType);
  if (cached && timestamp - cached.timestamp < RESOURCE_COLLECTION_CACHE_TTL) return cached.window;

  let window: ResourceCollectionWindow | null = null;
  try {
    window = await readResourceCollectionWindow(clientType);
  } catch (error) {
    logger.debug('读取资源全开放窗口失败，按周表判定关卡开放', {
      clientType,
      error: errorMessageOf(error)
    });
  }
  resourceCollectionCache.set(clientType, { timestamp, window });
  return window;
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
  const readWindow = runtime.readWindow ?? readCachedResourceCollectionWindow;
  let window: ResourceCollectionWindow | null = null;
  try {
    window = await readWindow(activityTableClientKey(clientType));
  } catch (error) {
    logger.debug('读取资源全开放窗口失败，按周表判定关卡开放', {
      clientType,
      error: errorMessageOf(error)
    });
    return false;
  }
  if (!window) return false;
  const now = (runtime.now ?? Date.now)();
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
  runActivity: clientType => execMaaCommand('activity', [clientType], null, null, false, true),
  readActivityTable: readMaaActivityTable,
  readFallback: clientType => getFallbackActivity(clientType),
  supportsFallback: supportsFallbackClient,
  loadConfig: async () => {
    const result = await loadUserConfig('activity-cache');
    return result.success ? result.data : null;
  },
  saveConfig: saveActivityConfig
};

/**
 * DTO 时间戳只接受安全整数：文件系统 mtime 是浮点毫秒，服务端缓存的时间戳
 * 也可能带小数；快照边界统一取整，避免跨端契约在客户端被判为非法载荷。
 */
function toDtoTimestamp(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : null;
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
    status,
    clientType,
    startTime: toDtoTimestamp(info.startTime),
    endTime: toDtoTimestamp(info.endTime),
    lastSuccessAt: toDtoTimestamp(lastSuccessAt),
    dataUpdatedAt: toDtoTimestamp(dataUpdatedAt),
    failure
  };
}

function emptyActivityInfo(source: string | null = null): MaaActivityInfo {
  return { code: null, name: null, source, startTime: null, endTime: null, stages: [] };
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
 * 读取顺序：新鲜内存/持久化缓存 → `maa activity` → 备用数据源。
 * 只有活动表存在且未过期时，maa 的空结果才能作为 `none`；否则继续查备用源。
 * 所有来源失败时，旧的成功缓存降级为 `stale`，没有旧数据才是 `unavailable`。
 */
export async function getCurrentActivity(
  clientType: string = DEFAULT_CLIENT_TYPE,
  overrides: MaaActivityRuntime = {}
): Promise<MaaActivitySnapshot> {
  const runtime = { ...defaultRuntime, ...overrides };
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

  let maaFailure: MaaActivityFailure | null = null;
  let table: MaaActivityTableState | null = null;
  try {
    const result = await runtime.runActivity(clientType);
    const output = String(result.stdout ?? '');
    const parsed = parseMaaActivityGroups(output);
    logger.debug('maa activity 原始输出', { output });

    if (parsed.groups.length > 0) {
      const group = parsed.groups[0];
      try {
        table = await runtime.readActivityTable();
      } catch {
        table = null;
      }
      const activity: MaaActivityInfo = {
        code: group.code,
        name: group.name,
        source: 'maa',
        startTime: null,
        endTime: null,
        // CLI 列出的是展示关卡，不是完整活动地图；完整 stages 待结构化活动表落地。
        stages: []
      };
      await persistActivity(runtime, persistedRecord, clientType, activity, now);
      return snapshotOf(clientType, activity, 'active', now, table?.modifiedAt ?? null, null);
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
          return snapshotOf(clientType, activity, 'none', now, table.modifiedAt, null);
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
      return snapshotOf(clientType, emptyActivityInfo('penguin'), 'none', now, now, null);
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
        stages: newestCandidate.stages
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

/** 写入内存与持久化缓存；保存失败只告警，返回结果仍以已读取的数据为准。 */
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
  try {
    await runtime.saveConfig({
      ...(persistedRecord ?? {}),
      [clientType]: cached
    });
  } catch (error) {
    logger.warn('保存活动缓存失败', { clientType, error: errorMessageOf(error) });
  }
}

/**
 * 替换关卡代号中的 hd 为实际活动代号
 */
export async function replaceActivityCode(stage: unknown, clientType: string = DEFAULT_CLIENT_TYPE): Promise<unknown> {
  if (!stage || typeof stage !== 'string') {
    return stage;
  }

  // 检查是否是 hd-数字 格式（不区分大小写）
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
