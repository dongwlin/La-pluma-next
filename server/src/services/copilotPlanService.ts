import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import TOML from '@iarna/toml';
import { execMaaCommand, execDynamicTask } from './maaExecutionService.ts';
import type { MaaDynamicTaskConfig } from './maaExecutionService.ts';
import { getCallbackDetails, getCallbackStringField, parseMaaCallbackEvents } from './maaCallbackService.ts';
import { getMaaConfigDir } from './maaConfigService.ts';
import { createMaaLogCheckpoint, readMaaLogIncrement, readMaaLogSince } from './maaLogFileService.ts';
import type { MaaLogCheckpoint, MaaLogIncrementStatus } from './maaLogFileService.ts';
import { invalidateCachedCopilotFiles } from './maaTaskCacheService.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import { resolveConnection } from './connectionService.ts';
import { recordDrops } from './dropRecordService.ts';
import { createOutboundHttpClient } from './outboundRequestService.ts';
import { createCopilotProgressStore } from './copilotProgressStore.ts';
import { readManagedCopilotFile } from './copilotFileService.ts';
import {
  resolveEffectiveResourceFilePath,
  resetEffectiveResourceDirsCache
} from './resourceUpdateService.ts';
import { updateJsonFile, writeJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('CopilotPlan');

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
// 作业进度是共享 JSON 状态：读改写经进度存储按路径排队执行；
// 默认位置保持 server/data/copilot-progress.json，可用环境变量注入隔离。
const progressStore = createCopilotProgressStore({
  progressPath: process.env.LA_PLUMA_COPILOT_PROGRESS_STORE || join(dataDir, 'copilot-progress.json')
});

// 作业站读取：服务内已有固定次数重试循环，端口侧关闭自动重试以保持总请求次数不变。
const outboundHttp = createOutboundHttpClient();

/**
 * 关卡目录所在的资源层：跟随资源消费者的共享解析（资源源优先，基础资源回落），
 * `stages.json` 与 `Arknights-Tile-Pos` 同层发布。文件缺失时返回基础资源目录，
 * 由调用方按目录缺失处理。
 */
function getStageCatalogDir(): Promise<string> {
  return resolveEffectiveResourceFilePath('stages.json').then(dirname);
}

interface StageCatalog {
  signature: string;
  filenames: string[];
  stages: Map<string, StageCode>;
}

interface CachedInstalledTasks {
  modifiedAt: number | null;
  tasks: unknown;
}

const stageCatalogCache = new Map<string, StageCatalog>();
const installedTasksCache = new Map<string, CachedInstalledTasks>();

async function readPathMtimeMs(path: string): Promise<number | null> {
  try {
    return Math.trunc((await stat(path)).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * 读取资源目录中的关卡索引。
 *
 * `Arknights-Tile-Pos` 有数千个文件，`stages.json` 接近 1MB；这两项不能按
 * 每次计划请求重新遍历与解析。目录/文件 mtime 不变时复用文件名列表和
 * stageId → code/apCost 映射，资源更新后签名变化自然失效。
 */
async function loadStageCatalog(resourceDir: string): Promise<StageCatalog> {
  const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
  const stagesPath = join(resourceDir, 'stages.json');
  const signature = `${await readPathMtimeMs(tileDir) ?? 'missing'}:${await readPathMtimeMs(stagesPath) ?? 'missing'}`;
  const cached = stageCatalogCache.get(resourceDir);
  if (cached?.signature === signature) return cached;

  const filenames = await readdir(tileDir);
  const stages = new Map<string, StageCode>();
  try {
    const parsed: unknown = JSON.parse(await readFile(stagesPath, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [];
    for (const stage of entries) {
      const stageId = readOptionalStringField(stage, 'stageId');
      const code = readOptionalStringField(stage, 'code');
      if (!stageId || !code) continue;
      stages.set(stageId, {
        code,
        apCost: readApCost(stage)
      });
    }
  } catch {}
  const catalog: StageCatalog = { signature, filenames, stages };
  stageCatalogCache.set(resourceDir, catalog);
  return catalog;
}

async function loadInstalledTasks(tasksPath: string): Promise<unknown> {
  const modifiedAt = await readPathMtimeMs(tasksPath);
  const cached = installedTasksCache.get(tasksPath);
  if (cached && modifiedAt !== null && cached.modifiedAt === modifiedAt) return cached.tasks;

  const tasks: unknown = JSON.parse(await readFile(tasksPath, 'utf8'));
  installedTasksCache.set(tasksPath, { modifiedAt, tasks });
  return tasks;
}

/** 清理进程内资源缓存、委托状态日志的一次性标记与测试注入的观察间隔、路径平台，供测试用例之间隔离；生产运行不调用。 */
export function resetCopilotPlanCachesForTests(): void {
  resetEffectiveResourceDirsCache();
  stageCatalogCache.clear();
  installedTasksCache.clear();
  fileLoadPollMsOverride = null;
  pathPlatformOverride = null;
  copilotNativeDelegationSettingLogged = false;
}

export type CopilotRaidMode = 'normal' | 'raid';

export type CopilotRaid = CopilotRaidMode | 'both';

export type CopilotRaidSelection = CopilotRaid | 'auto';

export type CopilotContent = Record<string, unknown>;

export interface StageCode {
  code: string;
  apCost: number | null;
}

export interface CopilotPlanItem {
  id: number;
  stageId: string;
  stage: string;
  apCost: number | null;
  presetFormation: boolean;
  supportsRaid: boolean;
  recommendedMode?: CopilotRaid;
  details?: string;
  operators: unknown[];
  groups: unknown[];
}

/**
 * 执行条目的公共字段：作业集条目带 `key`/`itemIndex`，活动计划条目没有；
 * `itemIndex` 缺省时重复文件名沿用原实现的 `undefined` 前缀。
 */
export interface CopilotExecutionEntry {
  copilotId: number;
  displayStage: string;
  mode: string;
  itemIndex?: number;
  stageId?: string;
  apCost?: number | null;
  presetFormation?: boolean;
  title?: string;
  uri?: string;
  content?: CopilotContent;
}

export interface CopilotPlanEntry extends CopilotExecutionEntry {
  key: string;
  itemIndex: number;
  stageId: string;
  apCost: number | null;
  mode: CopilotRaidMode;
  presetFormation: boolean;
  completed?: boolean;
}

export type CopilotQueueSource = 'prts' | 'file';

export type CopilotQueueFailurePolicy = 'stop' | 'continue';

export interface CopilotQueueEntryInput {
  clientId: string;
  source: CopilotQueueSource;
  copilotId?: number;
  filename?: string;
  mode: CopilotRaidSelection;
}

export interface CopilotQueuePlanEntry extends CopilotPlanEntry {
  clientId: string;
  source: CopilotQueueSource;
}

export interface CopilotQueuePlan {
  entries: CopilotQueuePlanEntry[];
}

/**
 * 执行选项：来自持久偏好、HTTP 请求或调用方组合，字段在使用处收窄，
 * 不在本层补默认值。
 */
export interface CopilotExecutionOptions {
  formationMode?: unknown;
  ignoreRequirements?: unknown;
  useSanityPotion?: unknown;
  addTrust?: unknown;
  formationIndex?: unknown;
  supportUsage?: unknown;
  supportName?: unknown;
  userAdditional?: unknown;
  loopTimes?: unknown;
  userResource?: unknown;
  raid?: unknown;
}

export interface CopilotListEntry {
  id?: number;
  filename: string;
  stage_name?: string;
  /** MaaCore 的导航关卡名覆盖；缺省时导航使用作业文件内的 `stage_name`。 */
  nav_name_override?: string;
  is_raid?: boolean;
}

export interface CopilotUserAdditional {
  name: string;
  skill?: number;
}

export interface CopilotTaskParams extends Record<string, unknown> {
  copilot_list: readonly CopilotListEntry[];
  formation: boolean;
  ignore_requirements: boolean;
  use_sanity_potion: boolean;
  add_trust: boolean;
  formation_index: number;
  support_unit_usage: number;
  support_unit_name: string;
  user_additional?: CopilotUserAdditional[];
}

export interface CopilotRepeatFile {
  repeat: number;
  filename: string;
}

export type CopilotEntryOutcomeStatus = 'success' | 'failed' | 'stopped' | 'pending';

export interface CopilotEntrySettlement<TEntry extends { key: string } = CopilotPlanEntry> {
  entry: TEntry;
  status: CopilotEntryOutcomeStatus;
  error?: string;
}

export type CopilotExecutionResult = CopilotPlanEntry & {
  success: boolean;
  error?: string;
  stopped?: boolean;
};

export interface CopilotTaskResult {
  key: string;
  itemIndex: number;
  copilotId: number;
  stageId: string;
  stage: string;
  displayStage: string;
  apCost: number | null;
  mode: string;
  presetFormation: boolean;
  status: CopilotEntryOutcomeStatus;
  error?: string;
}

export interface CopilotExecutionSummary {
  totalEntries: number;
  successCount: number;
  failedCount: number;
  stoppedCount: number;
  pendingCount: number;
  taskResults: CopilotTaskResult[];
}

/**
 * 原生委托未启用的原因。原生 Copilot 命令只表达整组统一参数，以下情形一旦
 * 放行就会改变 MaaCore 实际收到的任务参数。
 */
export type CopilotDelegationReason =
  | 'disabled'
  | 'no-entries'
  | 'single-entry'
  | 'preset-formation'
  | 'mixed-raid-mode'
  | 'formation-disabled'
  | 'loop-times'
  | 'user-additional'
  | 'duplicate-copilot'
  | 'unsupported-client-type'
  | 'unsupported-options'
  | 'stage-name-mismatch'
  | 'overlay-conflict'
  | 'overlay-unreadable';

/**
 * 原生委托的最终走向：`native-*` 表示没有回退，`fallback-*` 表示原生失败后
 * 回退到现有流程，并按现有流程的结果收尾。
 */
export type CopilotDelegationOutcome =
  | 'native-succeeded'
  | 'native-failed'
  | 'native-stopped'
  | 'fallback-succeeded'
  | 'fallback-failed'
  | 'fallback-stopped';

/** 一次执行的委托报告；`outcome` 显式区分原生成功、原生失败与回退后的结果。 */
export interface CopilotDelegationReport {
  attempted: boolean;
  reason?: CopilotDelegationReason;
  fallback?: boolean;
  outcome: CopilotDelegationOutcome;
  nativeError?: string;
}

/** 一次作业集执行的返回数据；错误以数据返回，由调用方决定是否视为失败。 */
export interface CopilotEntriesOutcome {
  success: boolean;
  stopped: boolean;
  error: unknown;
  results: CopilotExecutionResult[];
  completed: string[];
  pending: CopilotPlanEntry[];
  loopTimes: number;
  summary: CopilotExecutionSummary;
  delegation?: CopilotDelegationReport;
}

/** 执行生命周期钩子：调用方负责 Run 状态，本服务只在对应时机回调。 */
export interface CopilotExecutionLifecycle {
  onBeforeStart?: () => void | Promise<void>;
  onStarted?: () => void;
  shouldStop?: () => boolean | Promise<boolean>;
  onEntryStarted?: (entry: CopilotExecutionEntry, entries: readonly CopilotExecutionEntry[]) => void;
  onEntrySettled?: (entry: CopilotExecutionEntry, status: CopilotEntryOutcomeStatus, error?: string) => void;
}

export interface CopilotExecutionItem<TEntry extends CopilotExecutionEntry = CopilotExecutionEntry> {
  entry: TEntry;
  filename: string;
  repeat: number;
}

export interface CopilotExecutionGroup<TEntry extends CopilotExecutionEntry> {
  presetFormation: boolean | undefined;
  entries: TEntry[];
}

/** 作业集计划：条目携带进度，`completed` 由调用方决定是否跳过。 */
export interface CopilotPlan {
  setId: string;
  name: string;
  items: CopilotPlanItem[];
  entries: CopilotPlanEntry[];
}

/** 作业集执行结果：未停止时 success 为 true，逐项失败只体现在汇总里。 */
export interface CopilotPlanRunResult {
  success: true;
  stopped: boolean;
  plan: CopilotPlan;
  results: CopilotExecutionResult[];
  completed: string[];
  pending: CopilotPlanEntry[];
  loopTimes: number;
  summary: CopilotExecutionSummary;
  message?: string;
}

export interface CopilotPlanExecutionError extends Error {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
  retryable?: boolean;
  copilotPlan?: {
    plan: CopilotPlan;
    results: CopilotExecutionResult[];
    completed: string[];
  };
}

export interface CopilotSelectedExecutionResult {
  success: true;
  results: (CopilotExecutionEntry & { success: true })[];
  loopTimes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.message !== 'string' || !error.message) return undefined;
  return error.message;
}

function readOptionalStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field ? field : undefined;
}

function readOptionalNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

/** 关卡理智消耗：缺失或非法时保留未知，不能折叠成 0 参与展示或记录。 */
function readApCost(value: unknown): number | null {
  const apCost = readOptionalNumberField(value, 'apCost');
  return apCost !== undefined && apCost >= 0 ? apCost : null;
}

function readRecordField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

function parseCopilotContent(data: unknown): CopilotContent {
  const content = isRecord(data) ? data.content : undefined;
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(content) ? content : {};
}

function readCompletedEntryKeys(progress: unknown, setId: string | number): string[] {
  if (!isRecord(progress)) return [];
  const entries = progress[String(setId)];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function fetchJson(url: string, maxAttempts = 3): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { data: payload } = await outboundHttp.requestJson(url, {
        timeoutMs: 15000,
        retry: { maxRetries: 0 }
      });
      const statusCode = isRecord(payload) ? payload.status_code : undefined;
      if (statusCode && statusCode !== 200) {
        throw new Error(readOptionalStringField(payload, 'message') || '作业站返回失败');
      }
      return isRecord(payload) && payload.data ? payload.data : payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw new Error(`作业站请求失败: ${errorMessageOf(lastError) || '网络异常'}`, { cause: lastError });
}

export function isPresetFormationCopilot(copilot: unknown = {}): boolean {
  const content = isRecord(copilot) ? copilot : {};
  const stageName = String(content.stage_name || '');
  return (!Array.isArray(content.opers) || content.opers.length === 0) &&
    (!Array.isArray(content.groups) || content.groups.length === 0) &&
    /_s\d+$/i.test(stageName);
}

const STAGE_CODE_PATTERN = /\b(?:[A-Z]{1,5}|\d{1,2})-(?:(?:EX|S|MO|TR)-)?\d+\b/i;

function readTitleStageCode(title: string): string | undefined {
  return title.match(STAGE_CODE_PATTERN)?.[0];
}

export function getNavigationStage(copilot: unknown = {}): string {
  const content = isRecord(copilot) ? copilot : {};
  const doc = isRecord(content.doc) ? content.doc : {};
  const title = String(doc.title || '').trim();
  return readTitleStageCode(title) || title || String(content.stage_name || '');
}

function readDocDetails(content: CopilotContent): string | undefined {
  const doc = isRecord(content.doc) ? content.doc : {};
  const details = doc.details;
  return typeof details === 'string' && details.trim() ? details : undefined;
}

async function loadStageCodeMap(stageIds: readonly unknown[]): Promise<Map<string, StageCode>> {
  try {
    const resourceDir = await getStageCatalogDir();
    if (!resourceDir) return new Map();
    const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
    const catalog = await loadStageCatalog(resourceDir);
    const filenames = catalog.filenames;
    const result = new Map<string, StageCode>();
    const requestedStageIds = [...new Set(stageIds.filter(
      (stageId): stageId is string => typeof stageId === 'string' && Boolean(stageId)
    ))];
    await Promise.all(requestedStageIds.map(async stageId => {
      const filename = filenames.find(name =>
        name.endsWith('.json') && (name.startsWith(`${stageId}-`) || name.startsWith(`${stageId}#`))
      );
      if (filename) {
        try {
          const metadata: unknown = JSON.parse(await readFile(join(tileDir, filename), 'utf8'));
          const code = readOptionalStringField(metadata, 'code');
          if (code) result.set(stageId, { code, apCost: null });
        } catch {}
      }
      const stage = catalog.stages.get(stageId);
      if (stage) {
        const existing = result.get(stageId);
        result.set(stageId, {
          code: existing?.code || stage.code,
          apCost: stage.apCost ?? existing?.apCost ?? null
        });
      }
    }));
    const missingStageIds = requestedStageIds.filter(stageId => result.get(stageId)?.apCost == null);
    if (missingStageIds.length > 0) {
      try {
        const penguinStages = await fetchJson('https://penguin-stats.io/PenguinStats/api/v2/stages?server=CN');
        const stages = Array.isArray(penguinStages) ? penguinStages : [];
        for (const stage of stages) {
          const stageId = readOptionalStringField(stage, 'stageId');
          const code = readOptionalStringField(stage, 'code');
          if (!stageId || !missingStageIds.includes(stageId) || !code) continue;
          result.set(stageId, {
            code,
            apCost: readApCost(stage)
          });
        }
      } catch {}
    }
    return result;
  } catch {
    return new Map();
  }
}

function buildCopilotPlanItem(
  content: CopilotContent,
  {
    id,
    fallbackStage,
    stageCodes
  }: {
    id: number;
    fallbackStage: string;
    stageCodes: ReadonlyMap<string, StageCode>;
  }
): CopilotPlanItem {
  const stageId = typeof content.stage_name === 'string' ? content.stage_name : '';
  const presetFormation = isPresetFormationCopilot(content);
  const recommendedMode = readRecommendedMode(content.difficulty, presetFormation);
  const details = readDocDetails(content);
  return {
    id,
    stageId,
    stage: stageCodes.get(stageId)?.code || getNavigationStage(content) || fallbackStage,
    apCost: stageCodes.get(stageId)?.apCost ?? null,
    presetFormation,
    supportsRaid: !presetFormation,
    ...(recommendedMode ? { recommendedMode } : {}),
    ...(details ? { details } : {}),
    operators: Array.isArray(content.opers) ? content.opers : [],
    groups: Array.isArray(content.groups) ? content.groups : []
  };
}

function readRecommendedMode(difficulty: unknown, presetFormation: boolean): CopilotRaid | undefined {
  if (presetFormation || difficulty === 0 || difficulty === 1) return 'normal';
  if (difficulty === 2) return 'raid';
  if (difficulty === 3) return 'both';
  return undefined;
}

function expandCopilotModes(raid: unknown): CopilotRaidMode[] {
  if (raid === 'both') return ['normal', 'raid'];
  return [raid === 'raid' ? 'raid' : 'normal'];
}

export async function buildCopilotPlan(setId: string | number, raid: unknown = 'normal'): Promise<CopilotPlan> {
  const setPayload = await fetchJson(`https://prts.maa.plus/set/get?id=${encodeURIComponent(String(setId))}`);
  const setRecord = isRecord(setPayload) ? setPayload : {};
  const ids = Array.isArray(setRecord.copilot_ids) ? setRecord.copilot_ids : [];
  const copilotContents: { id: unknown; content: CopilotContent }[] = [];
  for (const id of ids) {
    const data = await fetchJson(`https://prts.maa.plus/copilot/get/${id}`);
    copilotContents.push({ id, content: parseCopilotContent(data) });
  }
  const stageCodes = await loadStageCodeMap(copilotContents.map(item => item.content.stage_name));
  const copilots: CopilotPlanItem[] = copilotContents.map(({ id, content }) => buildCopilotPlanItem(content, {
    id: Number(id),
    fallbackStage: `prts://${id}`,
    stageCodes
  }));

  const entries: CopilotPlanEntry[] = [];
  for (const [itemIndex, copilot] of copilots.entries()) {
    const requestedModes = expandCopilotModes(raid === 'auto' ? copilot.recommendedMode : raid);
    for (const mode of requestedModes) {
      if (mode === 'raid' && !copilot.supportsRaid) continue;
      entries.push({
        key: `${itemIndex}:${copilot.id}:${mode}`,
        itemIndex,
        copilotId: copilot.id,
        stageId: copilot.stageId,
        displayStage: copilot.stage,
        apCost: copilot.apCost,
        mode,
        presetFormation: copilot.presetFormation
      });
    }
  }
  const progress = await progressStore.load();
  const completed = new Set<string>(readCompletedEntryKeys(progress, setId));
  return {
    setId: String(setId),
    name: typeof setRecord.name === 'string' && setRecord.name ? setRecord.name : `作业集 ${setId}`,
    items: copilots,
    entries: entries.map(entry => ({ ...entry, completed: completed.has(entry.key) }))
  };
}

export interface BuildCopilotQueuePlanOptions {
  dataDir?: string;
}

/**
 * 本地文件用负数占位 id（不参与远端请求，也不与真实 copilot id 冲突），理智消耗保持未知。
 */
export async function buildCopilotQueuePlan(
  entries: readonly CopilotQueueEntryInput[],
  options: BuildCopilotQueuePlanOptions = {}
): Promise<CopilotQueuePlan> {
  const loaded: { entry: CopilotQueueEntryInput; content: CopilotContent }[] = [];
  for (const entry of entries) {
    if (entry.source === 'file') {
      const file = await readManagedCopilotFile(entry.filename, { dataDir: options.dataDir });
      loaded.push({ entry, content: file.content });
    } else {
      const data = await fetchJson(`https://prts.maa.plus/copilot/get/${entry.copilotId}`);
      loaded.push({ entry, content: parseCopilotContent(data) });
    }
  }
  const stageCodes = await loadStageCodeMap(loaded.map(item => item.content.stage_name));
  const planEntries = loaded.flatMap(({ entry, content }, itemIndex): CopilotQueuePlanEntry[] => {
    const remote = entry.source === 'prts';
    const copilotId = remote ? Number(entry.copilotId) : -(itemIndex + 1);
    const item = buildCopilotPlanItem(content, {
      id: copilotId,
      fallbackStage: remote ? `prts://${copilotId}` : '',
      stageCodes
    });
    const modeSelection = entry.mode === 'auto' ? item.recommendedMode : entry.mode;
    const modes = expandCopilotModes(modeSelection === 'both' && !item.supportsRaid ? 'normal' : modeSelection);
    return modes.map(mode => ({
      key: modes.length > 1 && mode === 'raid' ? `${entry.clientId}/raid` : entry.clientId,
      clientId: entry.clientId,
      source: entry.source,
      itemIndex,
      copilotId,
      stageId: item.stageId,
      displayStage: item.stage || item.stageId,
      apCost: remote ? item.apCost : null,
      mode,
      presetFormation: item.presetFormation,
      content
    }));
  });
  return { entries: planEntries };
}

/** MAA 任务定义：字段原样透传，合并只覆盖入口任务与 `BattleStart.next`。 */
export type MaaTaskDefinition = Record<string, unknown>;

export interface MergedPresetFormationTasks {
  [taskName: string]: unknown;
  LaPlumaPresetBattleConfirm: MaaTaskDefinition;
  BattleStart: MaaTaskDefinition;
}

export function mergePresetFormationTasks(installedTasks: unknown, userTasks: unknown = {}): MergedPresetFormationTasks {
  const installed = isRecord(installedTasks) ? installedTasks : {};
  const user = isRecord(userTasks) ? userTasks : {};
  const installedBattleStart = isRecord(installed.BattleStart) ? installed.BattleStart : {};
  const userBattleStart = isRecord(user.BattleStart) ? user.BattleStart : {};
  return {
    ...user,
    LaPlumaPresetBattleConfirm: {
      algorithm: 'OcrDetect',
      text: ['开始战斗', '是否开始战斗'],
      roi: [700, 430, 560, 280],
      action: 'ClickSelf',
      postDelay: 2000,
      next: ['BattleOfficiallyBegin', 'SkipThePreBattlePlot', 'Stop']
    },
    BattleStart: {
      ...installedBattleStart,
      ...userBattleStart,
      next: ['BattleOfficiallyBegin', 'LaPlumaPresetBattleConfirm', 'SkipThePreBattlePlot', 'Stop']
    }
  };
}

export interface CurrentMapStageTask {
  text: string[];
}

export function buildCurrentMapStageTasks(stages: unknown = []): Record<string, CurrentMapStageTask> {
  const list = Array.isArray(stages) ? stages : [];
  return Object.fromEntries([...new Set(list.map(stage => String(stage || '').trim().toUpperCase()).filter(Boolean))]
    .map(stage => [stage, { text: [stage] }]));
}

export interface CurrentMapActivityResource {
  stageFile: string;
  stages: string[];
}

export async function ensureCurrentMapActivityResource(
  configDir: string,
  activityCode: unknown,
  stages: unknown
): Promise<CurrentMapActivityResource> {
  const code = String(activityCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new Error('活动代号格式不合法');
  const tasks = buildCurrentMapStageTasks(stages);
  if (!Object.keys(tasks).length) throw new Error('没有可写入的活动关卡');
  const stageFile = join(configDir, 'resource', 'tasks', 'Stages', `${code}.json`);
  // 执行产物 JSON 经临时文件原子替换写入，中断不会留下半截关卡文件。
  await writeJsonFile(stageFile, tasks);
  return { stageFile, stages: Object.keys(tasks) };
}

export async function ensurePresetFormationResource(configDir: string): Promise<void> {
  const installedTasksPath = await resolveEffectiveResourceFilePath(join('tasks', 'tasks.json'));
  const installedTasks = await loadInstalledTasks(installedTasksPath);
  const userTasksPath = join(configDir, 'resource', 'tasks', 'tasks.json');
  // 用户 tasks.json 与安装资源的合并是共享资源读改写：读取、合并、写回在同一
  // 排队单元内原子完成；缺失文件按空任务合并，损坏文件报错且不覆盖原内容。
  await updateJsonFile(userTasksPath, current => mergePresetFormationTasks(installedTasks, current), {});
}

export function buildCopilotTaskParams(
  list: readonly CopilotListEntry[],
  presetFormation: boolean,
  options: CopilotExecutionOptions = {}
): CopilotTaskParams {
  const formation = presetFormation ? false : options.formationMode !== 'off';
  const userAdditional = formation ? normalizeUserAdditional(options.userAdditional) : [];
  return {
    copilot_list: list,
    formation,
    ignore_requirements: options.ignoreRequirements !== false,
    use_sanity_potion: options.useSanityPotion === true,
    add_trust: options.addTrust === true,
    formation_index: Number(options.formationIndex || 0),
    support_unit_usage: Number(options.supportUsage || 0),
    support_unit_name: String(options.supportName || ''),
    ...(userAdditional.length > 0 ? { user_additional: userAdditional } : {})
  };
}

/**
 * 追加干员仅在自动编队时生效；缺失姓名或技能不在 1–3 的条目按上游默认处理，
 * 不向 MaaCore 写入无效值。
 */
function normalizeUserAdditional(value: unknown): CopilotUserAdditional[] {
  const list = Array.isArray(value) ? value : [];
  const entries: CopilotUserAdditional[] = [];
  for (const item of list) {
    const name = readOptionalStringField(item, 'name')?.trim();
    if (!name) continue;
    const skill = readOptionalNumberField(item, 'skill');
    entries.push(
      skill !== undefined && Number.isInteger(skill) && skill >= 1 && skill <= 3
        ? { name, skill }
        : { name }
    );
  }
  return entries;
}

function normalizeCopilotLoopTimes(value: unknown): number {
  return Math.max(1, Math.min(99, Number.parseInt(String(value || 1), 10) || 1));
}

/**
 * 读取日志中成功加载的计划文件路径。
 *
 * MaaCore 把 `copilot_list` 收到的路径原文写进 `details.file_name`，整段载荷是
 * 一行 JSON：Windows 路径在日志文本里是 `C:\\maa\\...`，只有按 JSON 语义解析才能
 * 得到与 `path.join` 结果相同的 `C:\maa\...`。这里复用共享回调解析器，断行与
 * 非法 JSON 行跳过。
 */
export function extractLoadedCopilotFiles(logText: unknown = ''): string[] {
  return parseMaaCallbackEvents(String(logText ?? ''), 'Copilot')
    .filter(event => event.callback === 'SubTaskExtraInfo'
      && getCallbackStringField(event, 'what') === 'CopilotListLoadTaskFileSuccess')
    .map(event => getCallbackDetails(event)?.file_name)
    .filter((file): file is string => typeof file === 'string' && file.length > 0);
}

let pathPlatformOverride: NodeJS.Platform | null = null;

/** 测试注入：按指定平台规范化计划文件路径；生产代码不调用。 */
export function setCopilotPlanPathPlatformForTests(platform: NodeJS.Platform | null): void {
  pathPlatformOverride = platform;
}

/**
 * 计划文件路径的比较形式：分隔符统一为 `/`，Windows 上大小写不敏感。
 *
 * MaaCore 记录的是传入路径原文，计划文件路径由 `path.join` 生成；两边可能在
 * 分隔符、盘符与目录名大小写上不同，直接按字面比较会漏掉当前执行的条目。
 */
function normalizeCopilotPlanPath(file: string): string {
  const unified = file.replace(/\\/g, '/');
  return (pathPlatformOverride ?? process.platform) === 'win32' ? unified.toLowerCase() : unified;
}

function findCopilotExecutionItemIndex(
  executionItems: readonly { filename: string }[],
  file: string
): number {
  const target = normalizeCopilotPlanPath(file);
  if (!target) return -1;
  return executionItems.findIndex(item => {
    const planned = normalizeCopilotPlanPath(item.filename);
    return Boolean(planned) && (target === planned || target.endsWith(planned));
  });
}

/** 作业组执行中逐项观察的日志轮询间隔；MAA 回调落盘有延迟，过短只会空读。 */
const COPILOT_FILE_LOAD_POLL_MS = 2000;

let fileLoadPollMsOverride: number | null = null;

/** 测试注入：缩短计划文件加载观察的轮询间隔；生产代码不调用。 */
export function setCopilotFileLoadPollIntervalForTests(ms: number): void {
  fileLoadPollMsOverride = ms;
}

/**
 * 观察作业组执行期间 MAA 逐份加载的计划文件，推进逐项生命周期。
 *
 * MaaCore 的 `copilot_list` 按条目顺序执行：`MultiCopilotTaskPlugin::_run` 装载完
 * 当前条目的作业文件后才发出 `CopilotListLoadTaskFileSuccess`，之后才跳转关卡并
 * 战斗；每轮末尾的三星确认（`Copilot@WaitUntilEndOfAction`）失败会让任务链中止，
 * 后续文件不会被加载。因此第 k 份文件开始加载时，此前每份文件的轮次都已通过
 * 完成检查。据此把此前尚未结算的条目逐项结算为 success，并把第 k 份文件所属
 * 条目置为 running。
 *
 * 该前提依赖 MaaCore 的 copilot_list 执行顺序，升级 MaaCore 或更换 CLI 后需按
 * `docs/server/integrations.md` 的真实设备核对步骤复核。观察只是结算前的投影：
 * 组结束仍按命令退出码与最后加载的文件重新结算，读取失败或事件落在读取窗口外
 * 不会把未确认条目判为成功。
 */
function observeCopilotFileLoads({
  checkpoint,
  executionItems,
  alreadyStartedKeys,
  onEntryStarted,
  onEntrySettled,
  resolveItemIndex
}: {
  checkpoint: MaaLogCheckpoint | null;
  executionItems: readonly CopilotExecutionItem<CopilotPlanEntry>[];
  alreadyStartedKeys: readonly string[];
  onEntryStarted?: CopilotExecutionLifecycle['onEntryStarted'];
  onEntrySettled?: (entry: CopilotPlanEntry, status: CopilotEntryOutcomeStatus, error?: string) => void;
  resolveItemIndex?: (file: string) => number;
}): () => void {
  if (!onEntryStarted && !onEntrySettled) return () => {};

  const startedKeys = new Set(alreadyStartedKeys);
  const settledKeys = new Set<string>();
  const processedFiles = new Set<string>();
  // 条目各重复次数的文件在 executionItems 中连续；记录每个条目最后一份文件的位置。
  const entryLastIndexes = new Map<string, number>();
  for (const [index, item] of executionItems.entries()) {
    entryLastIndexes.set(item.entry.key, index);
  }
  let observing = true;
  let reading = false;

  const poll = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      const logText = await readMaaLogSince(checkpoint);
      if (!logText || !observing) return;
      for (const file of extractLoadedCopilotFiles(logText)) {
        if (!observing || processedFiles.has(file)) continue;
        processedFiles.add(file);
        const itemIndex = resolveItemIndex
          ? resolveItemIndex(file)
          : findCopilotExecutionItemIndex(executionItems, file);
        if (itemIndex < 0) continue;
        for (const [key, lastIndex] of entryLastIndexes) {
          if (lastIndex >= itemIndex || settledKeys.has(key)) continue;
          settledKeys.add(key);
          onEntrySettled?.(executionItems[lastIndex].entry, 'success');
        }
        const currentItem = executionItems[itemIndex].entry;
        if (!startedKeys.has(currentItem.key)) {
          startedKeys.add(currentItem.key);
          onEntryStarted?.(currentItem, [currentItem]);
        }
      }
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(() => {
    void poll().catch(() => {});
  }, fileLoadPollMsOverride ?? COPILOT_FILE_LOAD_POLL_MS);
  return () => {
    observing = false;
    clearInterval(timer);
  };
}

export function buildCopilotRepeatFiles(
  entry: Pick<CopilotExecutionEntry, 'copilotId' | 'mode' | 'itemIndex'>,
  loopTimes: unknown,
  planDir: string
): CopilotRepeatFile[] {
  return Array.from({ length: normalizeCopilotLoopTimes(loopTimes) }, (_, index) => ({
    repeat: index + 1,
    filename: join(planDir, `${entry.itemIndex}-${entry.copilotId}-${entry.mode}-${index + 1}.json`)
  }));
}

export interface PreparedCopilotList<TEntry extends CopilotExecutionEntry> {
  list: CopilotListEntry[];
  executionItems: CopilotExecutionItem<TEntry>[];
}

/**
 * `copilot_list` 条目的写入形状：`stage_name` 保留既有的展示关卡语义，
 * `nav_name_override` 显式给出 MaaCore 导航时使用的关卡名。
 */
export function buildCopilotListEntry(
  entry: Pick<CopilotExecutionEntry, 'displayStage' | 'mode'>,
  filename: string,
  id?: number
): CopilotListEntry {
  return {
    ...(id !== undefined ? { id } : {}),
    filename,
    stage_name: entry.displayStage,
    nav_name_override: entry.displayStage,
    is_raid: entry.mode === 'raid'
  };
}

async function prepareCopilotList<TEntry extends CopilotExecutionEntry>(
  entries: readonly TEntry[],
  { planDir, loopTimes }: { planDir: string; loopTimes: number }
): Promise<PreparedCopilotList<TEntry>> {
  const list: CopilotListEntry[] = [];
  const executionItems: CopilotExecutionItem<TEntry>[] = [];
  for (const entry of entries) {
    const content = entry.content
      ?? parseCopilotContent(await fetchJson(`https://prts.maa.plus/copilot/get/${entry.copilotId}`));
    for (const { repeat, filename } of buildCopilotRepeatFiles(entry, loopTimes, planDir)) {
      await writeJsonFile(filename, content);
      list.push(buildCopilotListEntry(entry, filename, executionItems.length));
      executionItems.push({ entry, filename, repeat });
    }
  }
  return { list, executionItems };
}

/**
 * Classifies the entries of one MAA Copilot command after it exited. MAA
 * loads plan files in order, so entries fully before the last loaded file are
 * confirmed. A stop leaves the in-flight entry `stopped` and later entries
 * `pending`; a failure marks everything not confirmed as failed.
 */
export function classifyCopilotEntryOutcomes<TEntry extends { key: string }>({
  entries,
  executionItems,
  currentIndex,
  stopped,
  message
}: {
  entries: readonly TEntry[];
  executionItems: readonly { entry: TEntry; filename: string }[];
  currentIndex: number;
  stopped: boolean;
  message: string;
}): CopilotEntrySettlement<TEntry>[] {
  return entries.map(entry => {
    const indexes = executionItems
      .map((item, index) => (item.entry.key === entry.key ? index : -1))
      .filter(index => index >= 0);
    const confirmed = indexes.length > 0 && currentIndex > 0 && indexes.every(index => index < currentIndex);
    if (confirmed) return { entry, status: 'success' };
    if (!stopped) return { entry, status: 'failed', error: message };
    if (currentIndex >= 0 && indexes.some(index => index <= currentIndex)) {
      return { entry, status: 'stopped', error: message };
    }
    return { entry, status: 'pending' };
  });
}

interface CopilotEntrySettlementState {
  status: CopilotEntryOutcomeStatus;
  error?: string;
}

function buildCopilotEntryOutcome({
  entries,
  statusByKey,
  completed,
  results,
  loopTimes,
  stopped,
  error,
  delegation
}: {
  entries: readonly CopilotPlanEntry[];
  statusByKey: ReadonlyMap<string, CopilotEntrySettlementState>;
  completed: ReadonlySet<string>;
  results: CopilotExecutionResult[];
  loopTimes: number;
  stopped: boolean;
  error: unknown;
  delegation?: CopilotDelegationReport;
}): CopilotEntriesOutcome {
  const taskResults: CopilotTaskResult[] = entries.map(entry => {
    const settled: CopilotEntrySettlementState = statusByKey.get(entry.key) || { status: 'pending' };
    return {
      key: entry.key,
      itemIndex: entry.itemIndex,
      copilotId: entry.copilotId,
      stageId: entry.stageId,
      stage: entry.displayStage,
      displayStage: entry.displayStage,
      apCost: entry.apCost,
      mode: entry.mode,
      presetFormation: Boolean(entry.presetFormation),
      status: settled.status,
      ...(settled.error ? { error: settled.error } : {})
    };
  });
  const count = (status: CopilotEntryOutcomeStatus) =>
    taskResults.filter(result => result.status === status).length;
  const summary: CopilotExecutionSummary = {
    totalEntries: taskResults.length,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    taskResults
  };
  return {
    success: summary.failedCount === 0,
    stopped,
    error: error || null,
    results,
    completed: [...completed],
    pending: entries.filter(entry => !completed.has(entry.key)),
    loopTimes,
    summary,
    ...(delegation ? { delegation } : {})
  };
}

interface CopilotGroupOutcome<TEntry extends CopilotPlanEntry = CopilotPlanEntry> {
  statuses: CopilotEntrySettlement<TEntry>[];
  error: unknown;
  stopped: boolean;
  batchFailure?: 'before-start' | 'unconfirmed';
}

const COPILOT_BATCH_LOG_BYTES = 64 * 1024 * 1024;

async function settleFailedCopilotBatch<TEntry extends CopilotPlanEntry>({
  checkpoint,
  entries,
  executionItems,
  observedSuccesses,
  commandStarted,
  stopped,
  error
}: {
  checkpoint: MaaLogCheckpoint | null;
  entries: readonly TEntry[];
  executionItems: readonly CopilotExecutionItem<TEntry>[];
  observedSuccesses: ReadonlySet<string>;
  commandStarted: boolean;
  stopped: boolean;
  error: unknown;
}): Promise<CopilotGroupOutcome<TEntry>> {
  const confirmed = new Set(observedSuccesses);
  let current: TEntry | undefined;
  let batchFailure: CopilotGroupOutcome['batchFailure'] = commandStarted ? 'unconfirmed' : 'before-start';
  if (commandStarted) {
    const log = await readMaaLogIncrement(checkpoint, COPILOT_BATCH_LOG_BYTES);
    if (log.status === 'ok') {
      let index = -1;
      let loadedIndex = -1;
      let clearedIndex = -1;
      let starts = 0;
      let failed = false;
      let valid = true;
      for (const event of parseMaaCallbackEvents(log.text, 'Copilot')) {
        if (event.callback === 'TaskChainStart') starts += 1;
        if (event.callback === 'TaskChainError') failed = true;
        if (event.callback === 'SubTaskStart') {
          if (event.subtask === 'MultiCopilotTask') index += 1;
          const task = getCallbackDetails(event)?.task;
          if (index === loadedIndex && (task === 'StageDrops-Stars-3' || task === 'StageDrops-Stars-Adverse')) {
            clearedIndex = index;
          }
        }
        if (event.callback !== 'SubTaskExtraInfo' || event.what !== 'CopilotListLoadTaskFileSuccess') continue;
        const file = getCallbackDetails(event)?.file_name;
        loadedIndex = typeof file === 'string' ? findCopilotExecutionItemIndex(executionItems, file) : -1;
        if (loadedIndex < 0 || loadedIndex < index) valid = false;
        index = loadedIndex;
      }
      if (starts === 1 && valid && (failed || stopped)) {
        if (index === -1) batchFailure = 'before-start';
        current = executionItems[index]?.entry;
        if (current) {
          batchFailure = undefined;
          for (const entry of entries) {
            if (entry.key === current.key) break;
            confirmed.add(entry.key);
          }
          if (index === clearedIndex && executionItems[index + 1]?.entry.key !== current.key) {
            confirmed.add(current.key);
          }
        }
      }
    }
  }
  const message = errorMessageOf(error) || '作业队列执行失败';
  return {
    statuses: entries.map(entry => {
      if (confirmed.has(entry.key)) return { entry, status: 'success' };
      if (entry.key === current?.key) return { entry, status: stopped ? 'stopped' : 'failed', error: message };
      return { entry, status: 'pending' };
    }),
    error: stopped ? null : error,
    stopped,
    ...(batchFailure ? { batchFailure } : {})
  };
}

async function runCopilotGroup<TEntry extends CopilotPlanEntry>({
  group,
  configDir,
  planDir,
  loopTimes,
  options,
  name,
  taskPrefix,
  taskLabel = `作业集 ${name}`,
  lifecycle,
  queueBatch = false
}: {
  group: CopilotExecutionGroup<TEntry>;
  configDir: string;
  planDir: string;
  loopTimes: number;
  options: CopilotExecutionOptions;
  name: string;
  taskPrefix: string;
  taskLabel?: string;
  lifecycle: CopilotExecutionLifecycle;
  queueBatch?: boolean;
}): Promise<CopilotGroupOutcome<TEntry>> {
  const checkpoint = await createMaaLogCheckpoint();
  let executionItems: CopilotExecutionItem<TEntry>[] = [];
  const observedSuccesses = new Set<string>();
  let commandStarted = false;
  try {
    const prepared = await prepareCopilotList(group.entries, { planDir, loopTimes });
    executionItems = prepared.executionItems;
    if (!prepared.list.length) {
      return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
    }

    // 只有真正开始执行的条目置为 running；组内后续条目由文件加载观察逐项推进。
    if (!queueBatch) lifecycle.onEntryStarted?.(group.entries[0], [group.entries[0]]);
    const stopObserving = observeCopilotFileLoads({
      checkpoint,
      executionItems,
      alreadyStartedKeys: [group.entries[0].key],
      onEntryStarted: lifecycle.onEntryStarted,
      onEntrySettled: queueBatch ? (entry, status, error) => {
        if (status === 'success') observedSuccesses.add(entry.key);
        lifecycle.onEntrySettled?.(entry, status, error);
      } : lifecycle.onEntrySettled
    });
    try {
      const taskId = `${taskPrefix}_${Date.now()}`;
      const taskConfig: MaaDynamicTaskConfig = {
        name: taskId,
        type: 'Copilot',
        params: buildCopilotTaskParams(prepared.list, group.presetFormation === true, options)
      };
      if (group.presetFormation) await ensurePresetFormationResource(configDir);
      await execDynamicTask(taskId, taskConfig, taskLabel, 'copilot', true, group.presetFormation || options.userResource === true, queueBatch ? {
        lifecycle: {
          onBeforeStart: async () => {
            if (await lifecycle.shouldStop?.()) {
              throw Object.assign(new Error('作业队列已停止'), { stopped: true });
            }
          },
          onStarted: () => {
            commandStarted = true;
            lifecycle.onEntryStarted?.(group.entries[0], [group.entries[0]]);
          }
        }
      } : undefined);
    } finally {
      // 观察在结算前停止：停止后未完成的日志读取不会再触发生命周期回调。
      stopObserving();
    }
    // 命令正常退出说明 copilot_list 的每一轮都通过了轮末三星确认（未通过会在
    // 轮末终止任务链并以非零码退出），组内条目按逐项 success 结算。
    return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
  } catch (error) {
    const wasStopped = Boolean(readBooleanField(error, 'stopped')) || Boolean(await lifecycle.shouldStop?.());
    if (queueBatch && group.entries.length > 1) {
      return settleFailedCopilotBatch({
        checkpoint,
        entries: group.entries,
        executionItems,
        observedSuccesses,
        commandStarted,
        stopped: wasStopped,
        error
      });
    }
    const logText = await readMaaLogSince(checkpoint).catch(() => '');
    const loadedFiles = extractLoadedCopilotFiles(logText);
    const currentFile = loadedFiles.at(-1) || '';
    const currentIndex = findCopilotExecutionItemIndex(executionItems, currentFile);
    const statuses = classifyCopilotEntryOutcomes({
      entries: group.entries,
      executionItems,
      currentIndex,
      stopped: wasStopped,
      message: errorMessageOf(error) || '作业集执行失败'
    });
    return {
      statuses,
      error: wasStopped ? null : error,
      stopped: wasStopped
    };
  }
}

/**
 * 灰度期默认关闭：未设置、空值、显式关闭或无法识别的取值都走现有流程，
 * 只有显式开启值才把满足等价条件的作业集交给原生 `maa copilot`。首次判定
 * 委托时记录一次实际生效状态，便于在真实设备验证前确认实例配置，不必
 * 改代码重新部署即可开启或回滚。
 */
const COPILOT_NATIVE_DELEGATION_ENV = 'LA_PLUMA_COPILOT_NATIVE_DELEGATION';
const COPILOT_NATIVE_DELEGATION_ENABLED_VALUES: ReadonlySet<string> = new Set([
  '1', 'true', 'on', 'yes', 'enable', 'enabled'
]);
const COPILOT_NATIVE_DELEGATION_DISABLED_VALUES: ReadonlySet<string> = new Set([
  '0', 'false', 'off', 'no', 'disabled'
]);

type CopilotNativeDelegationSetting =
  | { enabled: true; source: 'enabled'; value: string }
  | { enabled: false; source: 'default' | 'disabled' | 'invalid'; value?: string };

function readCopilotNativeDelegationSetting(): CopilotNativeDelegationSetting {
  const raw = process.env[COPILOT_NATIVE_DELEGATION_ENV];
  if (raw === undefined) return { enabled: false, source: 'default' };
  const value = raw.trim().toLowerCase();
  if (value === '') return { enabled: false, source: 'default' };
  if (COPILOT_NATIVE_DELEGATION_ENABLED_VALUES.has(value)) return { enabled: true, source: 'enabled', value: raw };
  if (COPILOT_NATIVE_DELEGATION_DISABLED_VALUES.has(value)) return { enabled: false, source: 'disabled', value: raw };
  return { enabled: false, source: 'invalid', value: raw };
}

let copilotNativeDelegationSettingLogged = false;

function logCopilotNativeDelegationSettingOnce(setting: CopilotNativeDelegationSetting): void {
  if (copilotNativeDelegationSettingLogged) return;
  copilotNativeDelegationSettingLogged = true;
  if (setting.enabled) {
    logger.info('原生 Copilot 委托已启用：满足等价条件的作业集交给 maa copilot', {
      env: COPILOT_NATIVE_DELEGATION_ENV,
      value: setting.value
    });
    return;
  }
  const sourceLabel = {
    default: '未设置或空值，灰度默认关闭',
    disabled: '环境变量显式关闭',
    invalid: '环境变量取值无法识别，按关闭处理'
  }[setting.source];
  logger.info(`原生 Copilot 委托未启用（${sourceLabel}）：作业集走现有流程`, {
    env: COPILOT_NATIVE_DELEGATION_ENV,
    ...(setting.value === undefined ? {} : { value: setting.value })
  });
}

/**
 * 读取本地资源中每个关卡 id 的展示代号（`Arknights-Tile-Pos` 的 `code`）。
 *
 * 原生命令与 MaaCore 都按这份代号生成导航关卡名，现有流程则把计划里的
 * `displayStage` 作为 `nav_name_override` 下发；只有两者相同才能保证导航到
 * 同一关卡。这里只读本地资源，缺失返回空映射。
 */
async function loadNativeStageCodes(stageIds: readonly string[]): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  let resourceDir: string;
  let catalog: StageCatalog;
  try {
    resourceDir = await getStageCatalogDir();
    if (!resourceDir) return codes;
    catalog = await loadStageCatalog(resourceDir);
  } catch {
    return codes;
  }
  const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
  await Promise.all([...new Set(stageIds)].map(async stageId => {
    const filename = catalog.filenames.find(name =>
      name.endsWith('.json') && (name.startsWith(`${stageId}-`) || name.startsWith(`${stageId}#`))
    );
    if (!filename) return;
    try {
      const metadata: unknown = JSON.parse(await readFile(join(tileDir, filename), 'utf8'));
      const code = readOptionalStringField(metadata, 'code');
      if (code) codes.set(stageId, code);
    } catch {}
  }));
  return codes;
}

/** 单作业的展示关卡：`stage` 是资源中的可读代号，`stageId` 是作业内容里的原始标识。 */
export interface CopilotStageIdentity {
  stageId: string;
  stage: string;
}

/**
 * 解析单作业的展示关卡。`payload` 接受 PRTS 单作业信封（`data.content`）或内层
 * `{ content }`，`content` 可为 JSON 字符串或已解析对象；本地导入也传 `{ content }`。
 * 代号优先取资源地图表，其次取文档标题中的代号；都没有时回退 `stage_name`，
 * 避免把内部关卡 id 当作代号展示。
 */
export async function resolveCopilotStageIdentity(payload: unknown): Promise<CopilotStageIdentity> {
  const source = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const content = parseCopilotContent(source);
  const stageId = typeof content.stage_name === 'string' ? content.stage_name.trim() : '';
  if (!stageId) return { stageId: '', stage: '' };
  const codes = await loadNativeStageCodes([stageId]);
  const doc = isRecord(content.doc) ? content.doc : {};
  const code = codes.get(stageId) ?? readTitleStageCode(String(doc.title || '').trim());
  return { stageId, stage: code || stageId };
}

export interface CopilotNativeDelegationInput {
  entries: readonly CopilotPlanEntry[];
  options?: CopilotExecutionOptions;
}

export type CopilotNativeDelegationDecision =
  | { eligible: true }
  | { eligible: false; reason: CopilotDelegationReason };

function hasRepresentableNumericOptions(options: CopilotExecutionOptions): boolean {
  const formationIndex = Number(options.formationIndex || 0);
  const supportUsage = Number(options.supportUsage || 0);
  return Number.isInteger(formationIndex) && formationIndex >= 0
    && Number.isInteger(supportUsage) && supportUsage >= 0;
}

/**
 * maa-cli 的 `copilot` 预设没有 `--client-type` 入口，任务参数未写 `client_type`
 * 时固定把 MaaCore 客户端类型设为 Official；连接 profile 使用其它客户端时，
 * 原生委托会按错误资源整组失败，而现有流程把 profile 的 client_type 写进 task.toml。
 */
const NATIVE_COPILOT_CLIENT_TYPE = 'Official';

async function resolveNativeCopilotClientType(): Promise<string> {
  try {
    return String((await resolveConnection()).clientType || '').trim();
  } catch (error) {
    logger.debug('读取连接客户端类型失败，跳过原生 Copilot 委托', {
      error: errorMessageOf(error)
    });
    return '';
  }
}

/**
 * maa-cli 把 `<config>/overlays/<task type>.<ext>` 作为预设命令的任务默认值，
 * 按 json、yaml、yml、toml 的顺序取第一个存在的文件；`maa run <task file>`
 * 不读取 overlay。原生 copilot 预设把用户布尔开关与 overlay 默认值取或、
 * 数字与字符串参数只在用户显式给出时才覆盖，因此 overlay 里把用户关闭的
 * 开关设成 true，或保留用户没有选择的值时，CLI 没有参数能改回现有流程下发的值。
 */
const NATIVE_COPILOT_OVERLAY_EXTENSIONS = ['json', 'yaml', 'yml', 'toml'] as const;

const NATIVE_COPILOT_OVERLAY_CONTROLLED_KEYS: ReadonlySet<string> = new Set([
  'copilot_list',
  'formation',
  'use_sanity_potion',
  'add_trust',
  'ignore_requirements',
  'formation_index',
  'support_unit_usage',
  'support_unit_name',
  'loop_times'
]);

const parseToml: (text: string) => Record<string, unknown> = TOML.parse;

type CopilotOverlayRead =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'loaded'; params: Record<string, unknown> };

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * 读取本机对原生 copilot 任务生效的 overlay；YAML 不在服务端依赖里，无法核对
 * 参数时按不可读处理，避免放行一个无法确认参数等价的委托。
 */
async function readNativeCopilotOverlay(): Promise<CopilotOverlayRead> {
  let configDir: string;
  try {
    configDir = (await getMaaConfigDir()).trim();
  } catch {
    return { state: 'unreadable' };
  }
  for (const extension of NATIVE_COPILOT_OVERLAY_EXTENSIONS) {
    let content: string;
    try {
      content = await readFile(join(configDir, 'overlays', `copilot.${extension}`), 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return { state: 'unreadable' };
    }
    if (extension === 'yaml' || extension === 'yml') return { state: 'unreadable' };
    try {
      const parsed: unknown = extension === 'json' ? JSON.parse(content) : parseToml(content);
      return isRecord(parsed) ? { state: 'loaded', params: parsed } : { state: 'unreadable' };
    } catch {
      return { state: 'unreadable' };
    }
  }
  return { state: 'missing' };
}

/** 现有流程显式下发的默认值；原生命令只在用户显式开启/大于 0/非空时才覆盖 overlay。 */
function hasNativeCopilotOverlayConflict(
  overlay: Record<string, unknown>,
  options: CopilotExecutionOptions
): boolean {
  if (Object.keys(overlay).some(key => !NATIVE_COPILOT_OVERLAY_CONTROLLED_KEYS.has(key))) return true;

  const booleanOptions: ReadonlyArray<readonly [string, boolean]> = [
    ['use_sanity_potion', options.useSanityPotion === true],
    ['add_trust', options.addTrust === true],
    ['ignore_requirements', options.ignoreRequirements !== false]
  ];
  for (const [key, enabled] of booleanOptions) {
    if (!enabled && overlay[key] === true) return true;
  }

  const numericOptions: ReadonlyArray<readonly [string, number]> = [
    ['formation_index', Number(options.formationIndex || 0)],
    ['support_unit_usage', Number(options.supportUsage || 0)]
  ];
  for (const [key, value] of numericOptions) {
    if (value !== 0 || !Object.hasOwn(overlay, key)) continue;
    const overlayValue = overlay[key];
    if (!(typeof overlayValue === 'number' && overlayValue === 0)) return true;
  }

  const supportName = String(options.supportName || '');
  if (supportName === '' && Object.hasOwn(overlay, 'support_unit_name')) {
    const overlayValue = overlay.support_unit_name;
    if (!(typeof overlayValue === 'string' && overlayValue === '')) return true;
  }
  return false;
}

/**
 * 判定整组条目能否交给原生 `maa copilot` 执行。
 *
 * 原生命令按 uri 顺序生成一份 `copilot_list`：每条目一份计划文件、统一
 * `--raid`、多条目时强制编队、列表模式忽略 `loop_times`，且没有
 * `user_additional` 与 `nav_name_override` 入口。只有这些差异都不影响实际
 * 下发给 MaaCore 的任务参数时才委托，否则回到现有流程；客户端类型不是
 * Official 时同样不能委托。
 */
export async function evaluateCopilotNativeDelegation({
  entries,
  options = {}
}: CopilotNativeDelegationInput): Promise<CopilotNativeDelegationDecision> {
  const setting = readCopilotNativeDelegationSetting();
  logCopilotNativeDelegationSettingOnce(setting);
  if (!setting.enabled) return { eligible: false, reason: 'disabled' };
  if (entries.length === 0) return { eligible: false, reason: 'no-entries' };
  if (entries.length < 2) return { eligible: false, reason: 'single-entry' };
  if (await resolveNativeCopilotClientType() !== NATIVE_COPILOT_CLIENT_TYPE) {
    return { eligible: false, reason: 'unsupported-client-type' };
  }
  if (entries.some(entry => entry.presetFormation)) {
    return { eligible: false, reason: 'preset-formation' };
  }
  if (new Set(entries.map(entry => entry.mode)).size !== 1) {
    return { eligible: false, reason: 'mixed-raid-mode' };
  }
  if (options.formationMode === 'off') return { eligible: false, reason: 'formation-disabled' };
  if (normalizeCopilotLoopTimes(options.loopTimes) !== 1) {
    return { eligible: false, reason: 'loop-times' };
  }
  if (normalizeUserAdditional(options.userAdditional).length > 0) {
    return { eligible: false, reason: 'user-additional' };
  }
  if (!hasRepresentableNumericOptions(options)) {
    return { eligible: false, reason: 'unsupported-options' };
  }
  const copilotIds = entries.map(entry => Number(entry.copilotId));
  if (new Set(copilotIds).size !== copilotIds.length) {
    return { eligible: false, reason: 'duplicate-copilot' };
  }
  const overlay = await readNativeCopilotOverlay();
  if (overlay.state === 'unreadable') return { eligible: false, reason: 'overlay-unreadable' };
  if (overlay.state === 'loaded' && hasNativeCopilotOverlayConflict(overlay.params, options)) {
    return { eligible: false, reason: 'overlay-conflict' };
  }
  const stageCodes = await loadNativeStageCodes(entries.map(entry => entry.stageId));
  if (!entries.every(entry => stageCodes.get(entry.stageId) === entry.displayStage)) {
    return { eligible: false, reason: 'stage-name-mismatch' };
  }
  return { eligible: true };
}

function buildNativeCopilotCommandArgs(
  entries: readonly CopilotPlanEntry[],
  options: CopilotExecutionOptions
): string[] {
  const args = [
    ...entries.map(entry => `prts://${Number(entry.copilotId)}`),
    '--raid',
    entries[0]?.mode === 'raid' ? 'raid' : 'normal',
    '--formation'
  ];
  if (options.ignoreRequirements !== false) args.push('--ignore-requirements');
  if (options.useSanityPotion === true) args.push('--use-sanity-potion');
  if (options.addTrust === true) args.push('--add-trust');
  const formationIndex = Number(options.formationIndex || 0);
  if (formationIndex > 0) args.push('--formation-index', String(formationIndex));
  const supportUsage = Number(options.supportUsage || 0);
  if (supportUsage > 0) args.push('--support-unit-usage', String(supportUsage));
  const supportName = String(options.supportName || '');
  if (supportName) args.push('--support-unit-name', supportName);
  if (options.userResource === true) args.push('--user-resource');
  args.push('--batch');
  return args;
}

/**
 * 原生命令把每个 copilot 下载到缓存目录的 `<id>.json`，日志里的
 * `file_name` 因此按 copilot id 而不是计划文件路径映射回条目。
 */
function findNativeCopilotItemIndex(
  executionItems: readonly { entry: CopilotPlanEntry }[],
  file: string
): number {
  const name = String(file || '').replace(/\\/g, '/').split('/').pop() || '';
  const match = name.match(/^(\d+)\.json$/i);
  if (!match) return -1;
  const copilotId = Number(match[1]);
  return executionItems.findIndex(item => Number(item.entry.copilotId) === copilotId);
}

interface NativeCopilotGroupOutcome extends CopilotGroupOutcome {
  observedLoads: number;
  logStatus: MaaLogIncrementStatus;
}

async function runNativeCopilotGroup({
  group,
  options,
  name,
  lifecycle
}: {
  group: CopilotExecutionGroup<CopilotPlanEntry>;
  options: CopilotExecutionOptions;
  name: string;
  lifecycle: CopilotExecutionLifecycle;
}): Promise<NativeCopilotGroupOutcome> {
  const checkpoint = await createMaaLogCheckpoint();
  const executionItems = group.entries.map(entry => ({
    entry,
    filename: `${Number(entry.copilotId)}.json`,
    repeat: 1
  }));
  const resolveItemIndex = (file: string): number => findNativeCopilotItemIndex(executionItems, file);
  try {
    // maa-cli 命中 `<cache>/copilot/<id>.json` 时直接复用而不校验远端内容；
    // 执行前删除本次条目的缓存，避免原生路径跑旧作业文件。
    await invalidateCachedCopilotFiles(group.entries.map(entry => entry.copilotId));
    lifecycle.onEntryStarted?.(group.entries[0], [group.entries[0]]);
    const stopObserving = observeCopilotFileLoads({
      checkpoint,
      executionItems,
      alreadyStartedKeys: [group.entries[0].key],
      onEntryStarted: lifecycle.onEntryStarted,
      onEntrySettled: lifecycle.onEntrySettled,
      resolveItemIndex
    });
    try {
      await execMaaCommand(
        'copilot',
        buildNativeCopilotCommandArgs(group.entries, options),
        `作业集 ${name}`,
        'copilot',
        true
      );
    } finally {
      stopObserving();
    }
    return {
      statuses: group.entries.map(entry => ({ entry, status: 'success' })),
      error: null,
      stopped: false,
      observedLoads: 0,
      logStatus: checkpoint ? 'ok' : 'unreadable'
    };
  } catch (error) {
    const logIncrement = await readMaaLogIncrement(checkpoint);
    const loadedFiles = extractLoadedCopilotFiles(logIncrement.text);
    const currentIndex = resolveItemIndex(loadedFiles.at(-1) || '');
    const wasStopped = Boolean(readBooleanField(error, 'stopped')) || Boolean(await lifecycle.shouldStop?.());
    const statuses = classifyCopilotEntryOutcomes({
      entries: group.entries,
      executionItems,
      currentIndex,
      stopped: wasStopped,
      message: errorMessageOf(error) || '作业集执行失败'
    });
    return {
      statuses,
      error: wasStopped ? null : error,
      stopped: wasStopped,
      observedLoads: loadedFiles.length,
      logStatus: logIncrement.status
    };
  }
}

/**
 * 计划文件加载发生在跳转关卡与开始战斗之前：原生失败时没有任何加载事件，说明
 * 原生执行没有进入关卡，回退不会重复消耗理智或重复结算关卡（游戏启动、编队等
 * 前置步骤可能已经执行）。只有完整读到检查点之后的增量日志才能确认这一点；
 * 检查点缺失、日志不可读或只读到部分新增内容时保守地不回退。
 */
function canFallbackToExistingFlow(outcome: NativeCopilotGroupOutcome): boolean {
  return Boolean(outcome.error)
    && !outcome.stopped
    && outcome.logStatus === 'ok'
    && outcome.observedLoads === 0
    && outcome.statuses.every(settled => settled.status !== 'success');
}

function nativeDelegationOutcome(outcome: NativeCopilotGroupOutcome): CopilotDelegationOutcome {
  if (outcome.stopped) return 'native-stopped';
  return outcome.error ? 'native-failed' : 'native-succeeded';
}

function fallbackDelegationOutcome(outcome: CopilotGroupOutcome): CopilotDelegationOutcome {
  if (outcome.stopped) return 'fallback-stopped';
  return outcome.error ? 'fallback-failed' : 'fallback-succeeded';
}

/** 执行作业集条目的输入；调用方拥有 Run，本函数只取设备租约。 */
export interface ExecuteCopilotEntriesInput {
  setId: string | number;
  name: string;
  entries?: readonly CopilotPlanEntry[];
  options?: CopilotExecutionOptions;
  lifecycle?: CopilotExecutionLifecycle;
  taskPrefix?: string;
}

/**
 * Executes selected copilot entries as one set attempt. The caller owns the
 * Run; this function acquires the device lease, reports per-entry status
 * through the lifecycle hooks and stops between groups when asked. Failures
 * are returned as data so callers can decide whether the set failed.
 */
export async function executeCopilotEntries({
  setId,
  name,
  entries = [],
  options = {},
  lifecycle = {},
  taskPrefix = `copilot_plan_${setId}`
}: ExecuteCopilotEntriesInput): Promise<CopilotEntriesOutcome> {
  const normalizedEntries = entries.filter(entry => Number.isInteger(Number(entry.copilotId)) && entry.displayStage);
  const loopTimes = normalizeCopilotLoopTimes(options.loopTimes);
  const progress = await progressStore.load();
  const completed = new Set<string>(readCompletedEntryKeys(progress, setId));
  const statusByKey = new Map<string, CopilotEntrySettlementState>(
    normalizedEntries.map(entry => [entry.key, { status: 'pending' }])
  );
  const results: CopilotExecutionResult[] = [];
  let stopped = false;
  let failure: unknown = null;
  let delegation: CopilotDelegationReport | undefined;

  if (normalizedEntries.length === 0) {
    return buildCopilotEntryOutcome({
      entries: normalizedEntries,
      statusByKey,
      completed,
      results,
      loopTimes,
      stopped: false,
      error: null
    });
  }

  await withMaaExecutionLease({
    source: 'copilot-set',
    taskName: name,
    command: 'copilot-plan'
  }, async () => {
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();
    const configDir = (await getMaaConfigDir()).trim();
    const planDir = join(configDir, 'copilot-plans', String(setId));
    await mkdir(planDir, { recursive: true });

    const decision = await evaluateCopilotNativeDelegation({ entries: normalizedEntries, options });
    if (!decision.eligible) logger.debug('作业集未启用原生委托', { setId, reason: decision.reason });

    const runExistingGroup = (group: CopilotExecutionGroup<CopilotPlanEntry>) => runCopilotGroup({
      group,
      configDir,
      planDir,
      loopTimes,
      options,
      name,
      taskPrefix,
      lifecycle
    });

    const groups = groupEntries(normalizedEntries);
    for (const [groupIndex, group] of groups.entries()) {
      if (await lifecycle.shouldStop?.()) {
        stopped = true;
        break;
      }

      let groupOutcome: CopilotGroupOutcome;
      if (groupIndex === 0 && groups.length === 1 && decision.eligible) {
        const nativeOutcome = await runNativeCopilotGroup({ group, options, name, lifecycle });
        if (canFallbackToExistingFlow(nativeOutcome)) {
          logger.warn('原生作业集执行失败，回退到现有流程', {
            setId,
            error: errorMessageOf(nativeOutcome.error)
          });
          groupOutcome = await runExistingGroup(group);
          delegation = {
            attempted: true,
            fallback: true,
            nativeError: errorMessageOf(nativeOutcome.error) || '原生作业集执行失败',
            outcome: fallbackDelegationOutcome(groupOutcome)
          };
        } else {
          delegation = {
            attempted: true,
            fallback: false,
            outcome: nativeDelegationOutcome(nativeOutcome)
          };
          groupOutcome = nativeOutcome;
        }
      } else {
        groupOutcome = await runExistingGroup(group);
      }
      groupOutcome.statuses.forEach(settled => {
        statusByKey.set(settled.entry.key, { status: settled.status, error: settled.error });
        lifecycle.onEntrySettled?.(settled.entry, settled.status, settled.error);
        if (settled.status === 'success') {
          completed.add(settled.entry.key);
          results.push({ ...settled.entry, success: true });
        } else if (settled.status !== 'pending') {
          results.push({
            ...settled.entry,
            success: false,
            error: settled.error,
            ...(settled.status === 'stopped' ? { stopped: true } : {})
          });
        }
      });
      const successfulEntries = groupOutcome.statuses
        .filter(settled => settled.status === 'success')
        .map(settled => settled.entry);
      try {
        await recordCompletedCopilotEntries(successfulEntries, loopTimes);
        // 读改写当前文件内容后仅替换本作业集的键，其他作业集的进度不受影响。
        await progressStore.update(current => ({
          ...(isRecord(current) ? current : {}),
          [String(setId)]: [...completed]
        }));
      } catch (error) {
        failure = error;
        break;
      }

      if (groupOutcome.stopped) {
        stopped = true;
        break;
      }
      if (groupOutcome.error) {
        failure = groupOutcome.error;
        break;
      }
    }
  });

  return buildCopilotEntryOutcome({
    entries: normalizedEntries,
    statusByKey,
    completed,
    results,
    loopTimes,
    stopped,
    error: failure,
    delegation
  });
}

export interface ExecuteCopilotQueueEntriesInput {
  queueId: string;
  name: string;
  entries: readonly CopilotQueuePlanEntry[];
  options?: CopilotExecutionOptions;
  failurePolicy?: CopilotQueueFailurePolicy;
  lifecycle?: CopilotExecutionLifecycle;
}

export interface CopilotQueueEntriesOutcome {
  stopped: boolean;
  error: unknown;
  statuses: CopilotEntrySettlement<CopilotQueuePlanEntry>[];
  completed: string[];
  loopTimes: number;
}

export async function executeCopilotQueueEntries({
  queueId,
  name,
  entries,
  options = {},
  failurePolicy = 'stop',
  lifecycle = {}
}: ExecuteCopilotQueueEntriesInput): Promise<CopilotQueueEntriesOutcome> {
  const loopTimes = normalizeCopilotLoopTimes(options.loopTimes);
  const statuses = new Map<string, CopilotEntrySettlement<CopilotQueuePlanEntry>>(
    entries.map(entry => [entry.key, { entry, status: 'pending' }])
  );
  const completed: string[] = [];
  let stopped = false;
  let failure: unknown = null;

  if (entries.length === 0) {
    return { stopped: false, error: null, statuses: [...statuses.values()], completed, loopTimes };
  }

  await withMaaExecutionLease({
    source: 'copilot-queue',
    taskName: name,
    command: 'copilot-queue'
  }, async () => {
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();
    const configDir = (await getMaaConfigDir()).trim();
    const planDir = join(configDir, 'copilot-plans', `queue-${queueId}`);
    await mkdir(planDir, { recursive: true });

    const attempts = groupEntries(entries);
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const group = attempts[attemptIndex];
      if (await lifecycle.shouldStop?.()) {
        stopped = true;
        break;
      }
      const outcome = await runCopilotGroup({
        group,
        configDir,
        planDir,
        loopTimes,
        options,
        name,
        taskPrefix: `copilot_queue_${queueId}_${attemptIndex}`,
        taskLabel: `作业队列 ${name}`,
        lifecycle,
        queueBatch: true
      });
      for (const settled of outcome.statuses) {
        statuses.set(settled.entry.key, settled);
        lifecycle.onEntrySettled?.(settled.entry, settled.status, settled.error);
      }
      const confirmed = outcome.statuses.filter(settled => settled.status === 'success').map(settled => settled.entry);
      completed.push(...confirmed.map(entry => entry.key));
      try {
        await recordCompletedCopilotEntries(confirmed, loopTimes);
      } catch (error) {
        failure = error;
        break;
      }
      if (outcome.stopped) {
        stopped = true;
        break;
      }
      if (outcome.batchFailure === 'before-start') {
        attempts.splice(attemptIndex + 1, 0, ...group.entries.map(entry => ({
          presetFormation: group.presetFormation,
          entries: [entry]
        })));
        continue;
      }
      if (outcome.batchFailure === 'unconfirmed') {
        failure = Object.assign(new Error('无法确认作业队列执行到了哪一步', { cause: outcome.error }), {
          retryable: false
        });
        break;
      }
      if (!outcome.error) continue;
      if (failurePolicy === 'stop') {
        if (confirmed.length && !outcome.statuses.some(settled => settled.status === 'failed')) failure = outcome.error;
        break;
      }
      const remaining = outcome.statuses.filter(settled => settled.status === 'pending').map(settled => settled.entry);
      if (remaining.length) attempts.splice(attemptIndex + 1, 0, { ...group, entries: remaining });
    }
  });

  return {
    stopped,
    error: stopped ? null : failure,
    statuses: [...statuses.values()],
    completed,
    loopTimes
  };
}

async function recordCompletedCopilotEntries(entries: readonly CopilotPlanEntry[], loopTimes: number): Promise<void> {
  for (const entry of entries) {
    await recordDrops({
      stage: entry.displayStage,
      times: loopTimes,
      sanity: (entry.apCost ?? 0) * loopTimes,
      medicine: 0,
      stone: 0,
      items: [],
      source: 'copilot',
      mode: entry.mode
    });
  }
}

function groupEntries<TEntry extends CopilotExecutionEntry>(
  entries: readonly TEntry[]
): CopilotExecutionGroup<TEntry>[] {
  const groups: CopilotExecutionGroup<TEntry>[] = [];
  for (const entry of entries) {
    const previous = groups[groups.length - 1];
    if (previous && previous.presetFormation === entry.presetFormation) previous.entries.push(entry);
    else groups.push({ presetFormation: entry.presetFormation, entries: [entry] });
  }
  return groups;
}

export interface ExecuteSelectedCopilotEntriesInput {
  planId: string | number;
  name: string;
  entries: readonly CopilotExecutionEntry[];
  options?: CopilotExecutionOptions;
  lifecycle?: CopilotExecutionLifecycle;
}

/**
 * Runs an already-selected list of copilot ids through the same dynamic MAA
 * Copilot task used by copilot sets. Callers must decide selection separately.
 */
export async function executeSelectedCopilotEntries({
  planId,
  name,
  entries,
  options = {},
  lifecycle = {}
}: ExecuteSelectedCopilotEntriesInput): Promise<CopilotSelectedExecutionResult> {
  const normalizedEntries = entries.filter(entry => Number.isInteger(Number(entry.copilotId)) && entry.displayStage);
  if (!normalizedEntries.length) throw new Error('没有可执行的作业条目');

  const results: (CopilotExecutionEntry & { success: true })[] = [];
  const loopTimes = normalizeCopilotLoopTimes(options.loopTimes);
  await withMaaExecutionLease({ source: 'activity-copilot', taskName: name, command: 'copilot-plan' }, async () => {
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();
    const configDir = (await getMaaConfigDir()).trim();
    const planDir = join(configDir, 'copilot-plans', String(planId));
    await mkdir(planDir, { recursive: true });

    for (const [groupIndex, group] of groupEntries(normalizedEntries).entries()) {
      const { list } = await prepareCopilotList(group.entries, { planDir, loopTimes });
      if (!list.length) continue;

      const taskId = `activity_copilot_${planId}_${groupIndex}`;
      const taskConfig: MaaDynamicTaskConfig = {
        name: taskId,
        type: 'Copilot',
        params: buildCopilotTaskParams(list, group.presetFormation === true, options)
      };
      if (group.presetFormation) await ensurePresetFormationResource(configDir);
      await execDynamicTask(taskId, taskConfig, name, 'copilot', true, group.presetFormation || options.userResource === true);
      results.push(...group.entries.map(entry => ({ ...entry, success: true as const })));
    }
  });

  return { success: true, results, loopTimes };
}

/** 作业集计划执行输入：`selectedIndexes` 为空表示执行全部未完成条目。 */
export interface ExecuteCopilotPlanInput {
  setId: string | number;
  raid?: unknown;
  selectedIndexes?: readonly (string | number)[];
  options?: CopilotExecutionOptions;
  lifecycle?: CopilotExecutionLifecycle;
}

export async function executeCopilotPlan({
  setId,
  raid = 'normal',
  selectedIndexes = [],
  options = {},
  lifecycle = {}
}: ExecuteCopilotPlanInput): Promise<CopilotPlanRunResult> {
  const plan = await buildCopilotPlan(setId, raid);
  const selected = new Set(selectedIndexes.map(Number));
  const selectedEntries = plan.entries.filter(entry => selected.size === 0 || selected.has(entry.itemIndex));
  const progress = await progressStore.load();
  const completed = new Set<string>(readCompletedEntryKeys(progress, setId));
  const pending = selectedEntries.filter(entry => !completed.has(entry.key));

  const outcome = await executeCopilotEntries({
    setId,
    name: plan.name,
    entries: pending,
    options,
    lifecycle,
    taskPrefix: `copilot_plan_${setId}`
  });

  if (outcome.error && !outcome.stopped) {
    const error = new Error(errorMessageOf(outcome.error) || '作业集执行失败', {
      cause: outcome.error
    }) as CopilotPlanExecutionError;
    error.code = readOptionalStringField(outcome.error, 'code') || 'COPILOT_PLAN_FAILED';
    error.statusCode = readOptionalNumberField(outcome.error, 'statusCode') || 422;
    error.details = {
      ...readRecordField(outcome.error, 'details'),
      plan,
      results: outcome.results,
      completed: outcome.completed,
      summary: outcome.summary,
      stopped: false
    };
    error.retryable = true;
    throw Object.assign(error, { copilotPlan: { plan, results: outcome.results, completed: outcome.completed } });
  }

  const result: CopilotPlanRunResult = {
    success: true,
    stopped: outcome.stopped,
    plan,
    results: outcome.results,
    completed: outcome.completed,
    pending: selectedEntries.filter(entry => !outcome.completed.includes(entry.key)),
    loopTimes: outcome.loopTimes,
    summary: outcome.summary
  };
  if (outcome.stopped) return { ...result, message: '作业集已被终止' };
  return result;
}

export async function resetCopilotPlanProgress(setId: string | number): Promise<{ success: true }> {
  // 读改写删除单键：并发保存其他作业集进度的更新不会丢失，损坏文件报错且不清零。
  await progressStore.update(current => {
    const next: Record<string, unknown> = isRecord(current) ? { ...current } : {};
    delete next[String(setId)];
    return next;
  });
  return { success: true };
}
