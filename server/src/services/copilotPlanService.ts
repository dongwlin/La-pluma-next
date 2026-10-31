import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execMaaCommand, execDynamicTask } from './maaExecutionService.ts';
import type { MaaDynamicTaskConfig } from './maaExecutionService.ts';
import { getMaaConfigDir } from './maaConfigService.ts';
import { createMaaLogCheckpoint, readMaaLogSince } from './maaLogFileService.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import { recordDrops } from './dropRecordService.ts';
import { createOutboundHttpClient } from './outboundRequestService.ts';
import { createCopilotProgressStore } from './copilotProgressStore.ts';
import { updateJsonFile, writeJsonFile } from '../utils/fileHelper.ts';

/**
 * 作业集计划与执行。
 *
 * - 作业站载荷按 unknown 收窄：计划条目只保留执行与进度判定需要的字段。
 * - 计划构建只读取作业站、MAA 资源与共享进度；真正的设备执行集中在
 *   `executeCopilotEntries`/`executeSelectedCopilotEntries`，两者都先取设备租约。
 * - 共享进度读改写经进度存储排队；失败与停止按数据返回，由调用方决定终态。
 */

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
// 作业进度是共享 JSON 状态：读改写经进度存储按路径排队执行；
// 默认位置保持 server/data/copilot-progress.json，可用环境变量注入隔离。
const progressStore = createCopilotProgressStore({
  progressPath: process.env.LA_PLUMA_COPILOT_PROGRESS_STORE || join(dataDir, 'copilot-progress.json')
});

// 作业站读取：服务内已有固定次数重试循环，端口侧关闭自动重试以保持总请求次数不变。
const outboundHttp = createOutboundHttpClient();

/**
 * `maa dir resource` 的进程内缓存：资源目录在进程生命周期内稳定。
 * 计划构建与预设编队写入共用解析结果；失败不缓存，下一次调用重新尝试。
 */
let resourceDirPromise: Promise<string> | null = null;

function getMaaResourceDir(): Promise<string> {
  if (!resourceDirPromise) {
    resourceDirPromise = execMaaCommand('dir', ['resource'], null, null, false, true)
      .then(result => result.stdout.trim())
      .catch(error => {
        resourceDirPromise = null;
        throw error;
      });
  }
  return resourceDirPromise;
}

/** 资源目录签名：目录或 `stages.json` 的修改时间变化时重新解析。 */
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
        apCost: Math.max(0, Number(isRecord(stage) ? stage.apCost : 0) || 0)
      });
    }
  } catch {}
  const catalog: StageCatalog = { signature, filenames, stages };
  stageCatalogCache.set(resourceDir, catalog);
  return catalog;
}

/** 已安装 `tasks.json` 的解析缓存；修改时间不变时不重复读取文件。 */
async function loadInstalledTasks(resourceDir: string): Promise<unknown> {
  const tasksPath = join(resourceDir, 'tasks', 'tasks.json');
  const modifiedAt = await readPathMtimeMs(tasksPath);
  const cached = installedTasksCache.get(tasksPath);
  if (cached && modifiedAt !== null && cached.modifiedAt === modifiedAt) return cached.tasks;

  const tasks: unknown = JSON.parse(await readFile(tasksPath, 'utf8'));
  installedTasksCache.set(tasksPath, { modifiedAt, tasks });
  return tasks;
}

/** 清理进程内资源缓存，供测试用例之间隔离；生产运行不调用。 */
export function resetCopilotPlanCachesForTests(): void {
  resourceDirPromise = null;
  stageCatalogCache.clear();
  installedTasksCache.clear();
}

/** 执行模式：普通关卡或突袭。 */
export type CopilotRaidMode = 'normal' | 'raid';

/** 计划可请求的执行模式；`both` 按条目兼容性展开为普通与突袭。 */
export type CopilotRaid = CopilotRaidMode | 'both';

/** 作业站返回的作业内容：字段按使用处逐项收窄，未知字段原样交给执行端。 */
export type CopilotContent = Record<string, unknown>;

/** MAA 资源中解析出的关卡代号与理智消耗。 */
export interface StageCode {
  code: string;
  apCost: number;
}

/** 作业集计划中的单个作业：由作业站内容收窄而来。 */
export interface CopilotPlanItem {
  id: number;
  stageId: string;
  stage: string;
  apCost: number;
  presetFormation: boolean;
  supportsRaid: boolean;
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
  apCost?: number;
  presetFormation?: boolean;
  title?: string;
  uri?: string;
}

/** 作业集计划条目：`key` 标识进度与逐项状态，`itemIndex` 标识原始作业序号。 */
export interface CopilotPlanEntry extends CopilotExecutionEntry {
  key: string;
  itemIndex: number;
  stageId: string;
  apCost: number;
  mode: CopilotRaidMode;
  presetFormation: boolean;
  completed?: boolean;
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
  loopTimes?: unknown;
  userResource?: unknown;
  raid?: unknown;
}

/** MAA Copilot 任务的 copilot_list 条目。 */
export interface CopilotListEntry {
  id?: number;
  filename: string;
  stage_name?: string;
  is_raid?: boolean;
}

/** 动态 Copilot 任务的参数：字段名与 MAA CLI 约定一致。 */
export interface CopilotTaskParams extends Record<string, unknown> {
  copilot_list: readonly CopilotListEntry[];
  formation: boolean;
  ignore_requirements: boolean;
  use_sanity_potion: boolean;
  add_trust: boolean;
  formation_index: number;
  support_unit_usage: number;
  support_unit_name: string;
}

/** 单次重复执行的计划文件。 */
export interface CopilotRepeatFile {
  repeat: number;
  filename: string;
}

/** 执行条目的结算状态：确认成功、失败、因停止未执行完或尚未执行。 */
export type CopilotEntryOutcomeStatus = 'success' | 'failed' | 'stopped' | 'pending';

/** 单个条目的结算结果。 */
export interface CopilotEntrySettlement<TEntry extends { key: string } = CopilotPlanEntry> {
  entry: TEntry;
  status: CopilotEntryOutcomeStatus;
  error?: string;
}

/** 逐项结果：成功条目带 success:true，失败或停止条目带 error。 */
export type CopilotExecutionResult = CopilotPlanEntry & {
  success: boolean;
  error?: string;
  stopped?: boolean;
};

/** 汇总中的单项状态投影。 */
export interface CopilotTaskResult {
  key: string;
  itemIndex: number;
  copilotId: number;
  stageId: string;
  stage: string;
  displayStage: string;
  apCost: number;
  mode: string;
  presetFormation: boolean;
  status: CopilotEntryOutcomeStatus;
  error?: string;
}

/** 一次执行的逐项汇总。 */
export interface CopilotExecutionSummary {
  totalEntries: number;
  successCount: number;
  failedCount: number;
  stoppedCount: number;
  pendingCount: number;
  taskResults: CopilotTaskResult[];
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
}

/** 执行生命周期钩子：调用方负责 Run 状态，本服务只在对应时机回调。 */
export interface CopilotExecutionLifecycle {
  onBeforeStart?: () => void | Promise<void>;
  onStarted?: () => void;
  shouldStop?: () => boolean | Promise<boolean>;
  onEntryStarted?: (entry: CopilotExecutionEntry, entries: readonly CopilotExecutionEntry[]) => void;
  onEntrySettled?: (entry: CopilotExecutionEntry, status: CopilotEntryOutcomeStatus, error?: string) => void;
}

/** 已写入计划文件的单个执行条目；`repeat` 为该条目第几次重复。 */
export interface CopilotExecutionItem<TEntry extends CopilotExecutionEntry = CopilotExecutionEntry> {
  entry: TEntry;
  filename: string;
  repeat: number;
}

/** 按预设编队兼容性分组后的执行单元。 */
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

/** 作业集执行失败的错误：沿用统一错误信封字段，并附带已算出的计划与逐项结果。 */
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

/** 已选活动条目的执行结果。 */
export interface CopilotSelectedExecutionResult {
  success: true;
  results: (CopilotExecutionEntry & { success: true })[];
  loopTimes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取结构化错误上的 message；非字符串按缺失处理，由调用方给兜底文案。 */
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

/** 作业内容可能是 JSON 字符串或已解析对象；无法解析为对象时按空内容处理。 */
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

/** 计划读取的进度形状：`{ [作业集id]: [已完成条目键] }`；非字符串条目键忽略。 */
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

export function getNavigationStage(copilot: unknown = {}): string {
  const content = isRecord(copilot) ? copilot : {};
  const doc = isRecord(content.doc) ? content.doc : {};
  const title = String(doc.title || '').trim();
  const code = title.match(/\b(?:[A-Z]{1,5}|\d{1,2})-(?:(?:EX|S|MO|TR)-)?\d+\b/i)?.[0];
  return code || title || String(content.stage_name || '');
}

async function loadStageCodeMap(stageIds: readonly unknown[]): Promise<Map<string, StageCode>> {
  try {
    const resourceDir = await getMaaResourceDir();
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
          if (code) result.set(stageId, { code, apCost: 0 });
        } catch {}
      }
      const stage = catalog.stages.get(stageId);
      if (stage) {
        const existing = result.get(stageId);
        result.set(stageId, {
          code: existing?.code || stage.code,
          apCost: stage.apCost
        });
      }
    }));
    const missingStageIds = requestedStageIds.filter(stageId => !result.get(stageId)?.apCost);
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
            apCost: Math.max(0, Number(isRecord(stage) ? stage.apCost : 0) || 0)
          });
        }
      } catch {}
    }
    return result;
  } catch {
    return new Map();
  }
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
  const copilots: CopilotPlanItem[] = copilotContents.map(({ id, content }) => {
    const stageId = typeof content.stage_name === 'string' ? content.stage_name : '';
    return {
      id: Number(id),
      stageId,
      stage: stageCodes.get(stageId)?.code || getNavigationStage(content) || `prts://${id}`,
      apCost: stageCodes.get(stageId)?.apCost || 0,
      presetFormation: isPresetFormationCopilot(content),
      supportsRaid: !isPresetFormationCopilot(content),
      operators: Array.isArray(content.opers) ? content.opers : [],
      groups: Array.isArray(content.groups) ? content.groups : []
    };
  });

  const requestedModes: CopilotRaidMode[] = raid === 'both'
    ? ['normal', 'raid']
    : [raid === 'raid' ? 'raid' : 'normal'];
  const entries: CopilotPlanEntry[] = [];
  for (const [itemIndex, copilot] of copilots.entries()) {
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

/** MAA 任务定义：字段原样透传，合并只覆盖入口任务与 `BattleStart.next`。 */
export type MaaTaskDefinition = Record<string, unknown>;

/** 合并后的 `tasks.json`：保证预设编队确认任务与 BattleStart 链存在。 */
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

/** 当前地图兜底关卡的 OCR 任务：关卡代号直接作为识别文本。 */
export interface CurrentMapStageTask {
  text: string[];
}

export function buildCurrentMapStageTasks(stages: unknown = []): Record<string, CurrentMapStageTask> {
  const list = Array.isArray(stages) ? stages : [];
  return Object.fromEntries([...new Set(list.map(stage => String(stage || '').trim().toUpperCase()).filter(Boolean))]
    .map(stage => [stage, { text: [stage] }]));
}

/** 当前地图兜底写入的关卡资源摘要。 */
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
  const installedResource = await getMaaResourceDir();
  const installedTasks = await loadInstalledTasks(installedResource);
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
  return {
    copilot_list: list,
    formation: presetFormation ? false : options.formationMode !== 'off',
    ignore_requirements: options.ignoreRequirements !== false,
    use_sanity_potion: options.useSanityPotion === true,
    add_trust: options.addTrust === true,
    formation_index: Number(options.formationIndex || 0),
    support_unit_usage: Number(options.supportUsage || 0),
    support_unit_name: String(options.supportName || '')
  };
}

function normalizeCopilotLoopTimes(value: unknown): number {
  return Math.max(1, Math.min(99, Number.parseInt(String(value || 1), 10) || 1));
}

export function extractLoadedCopilotFiles(logText: unknown = ''): string[] {
  // MAA writes `file_name` inside `details` before the trailing `what`
  // discriminator for a successfully loaded copilot entry.
  return [...String(logText).matchAll(/"file_name"\s*:\s*"([^"]+)"[\s\S]{0,500}?"what"\s*:\s*"CopilotListLoadTaskFileSuccess"/g)]
    .map(match => match[1]);
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

/** 已写入计划文件的条目集合；`executionItems` 保留条目与其重复次数。 */
export interface PreparedCopilotList<TEntry extends CopilotExecutionEntry> {
  list: CopilotListEntry[];
  executionItems: CopilotExecutionItem<TEntry>[];
}

async function prepareCopilotList<TEntry extends CopilotExecutionEntry>(
  entries: readonly TEntry[],
  { planDir, loopTimes }: { planDir: string; loopTimes: number }
): Promise<PreparedCopilotList<TEntry>> {
  const list: CopilotListEntry[] = [];
  const executionItems: CopilotExecutionItem<TEntry>[] = [];
  for (const entry of entries) {
    const data = await fetchJson(`https://prts.maa.plus/copilot/get/${entry.copilotId}`);
    const content = parseCopilotContent(data);
    for (const { repeat, filename } of buildCopilotRepeatFiles(entry, loopTimes, planDir)) {
      await writeJsonFile(filename, content);
      list.push({
        id: executionItems.length,
        filename,
        stage_name: entry.displayStage,
        is_raid: entry.mode === 'raid'
      });
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

/** 条目在本次执行中的结算状态；未结算条目的缺省状态为 pending。 */
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
  error
}: {
  entries: readonly CopilotPlanEntry[];
  statusByKey: ReadonlyMap<string, CopilotEntrySettlementState>;
  completed: ReadonlySet<string>;
  results: CopilotExecutionResult[];
  loopTimes: number;
  stopped: boolean;
  error: unknown;
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
    summary
  };
}

/** 单组执行结果：`error` 为原始抛出值，`stopped` 表示主动停止而非失败。 */
interface CopilotGroupOutcome {
  statuses: CopilotEntrySettlement[];
  error: unknown;
  stopped: boolean;
}

async function runCopilotGroup({
  group,
  configDir,
  planDir,
  loopTimes,
  options,
  name,
  taskPrefix,
  lifecycle
}: {
  group: CopilotExecutionGroup<CopilotPlanEntry>;
  configDir: string;
  planDir: string;
  loopTimes: number;
  options: CopilotExecutionOptions;
  name: string;
  taskPrefix: string;
  lifecycle: CopilotExecutionLifecycle;
}): Promise<CopilotGroupOutcome> {
  const checkpoint = await createMaaLogCheckpoint();
  let executionItems: CopilotExecutionItem<CopilotPlanEntry>[] = [];
  try {
    const prepared = await prepareCopilotList(group.entries, { planDir, loopTimes });
    executionItems = prepared.executionItems;
    if (!prepared.list.length) {
      return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
    }

    lifecycle.onEntryStarted?.(group.entries[0], group.entries);
    const taskId = `${taskPrefix}_${Date.now()}`;
    const taskConfig: MaaDynamicTaskConfig = {
      name: taskId,
      type: 'Copilot',
      params: buildCopilotTaskParams(prepared.list, group.presetFormation === true, options)
    };
    if (group.presetFormation) await ensurePresetFormationResource(configDir);
    await execDynamicTask(taskId, taskConfig, `作业集 ${name}`, 'copilot', true, group.presetFormation || options.userResource === true);
    return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
  } catch (error) {
    const logText = await readMaaLogSince(checkpoint).catch(() => '');
    const loadedFiles = extractLoadedCopilotFiles(logText);
    const currentFile = loadedFiles.at(-1) || '';
    const currentIndex = executionItems.findIndex(item => currentFile === item.filename || currentFile.endsWith(item.filename));
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
      stopped: wasStopped
    };
  }
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

    for (const group of groupEntries(normalizedEntries)) {
      if (await lifecycle.shouldStop?.()) {
        stopped = true;
        break;
      }

      const groupOutcome = await runCopilotGroup({
        group,
        configDir,
        planDir,
        loopTimes,
        options,
        name,
        taskPrefix,
        lifecycle
      });
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
    error: failure
  });
}

async function recordCompletedCopilotEntries(entries: readonly CopilotPlanEntry[], loopTimes: number): Promise<void> {
  for (const entry of entries) {
    await recordDrops({
      stage: entry.displayStage,
      times: loopTimes,
      sanity: entry.apCost * loopTimes,
      medicine: 0,
      stone: 0,
      items: [],
      source: 'copilot',
      mode: entry.mode
    });
  }
}

/** 相邻条目按预设编队兼容性分组；不改变条目顺序。 */
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

/** 已选活动条目的执行输入；条目来自活动计划，不带作业集进度键。 */
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
