/**
 * 养成领域文件访问的唯一入口：所有 JSON 读取先经本模块解析函数校验为领域类型，
 * 损坏或结构不符的条目按各 load/parse 策略回退，不以 unknown 进入计算；
 * 训练队列写入经 `serializeTrainingMutation` 串行并维护 queueRevision。
 */

import path from 'path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readJsonFile, writeJsonFile, updateJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { resolveAppPaths } from '../config/runtimeConfig.ts';
import { resolveEffectiveResourceFilePath } from './resourceUpdateService.ts';
import {
  DEFAULT_TRAINING_SETTINGS,
  isRecord,
  normalizeTrainingSettings
} from './operatorTrainingModel.ts';
import { parseOperBoxCatalog } from './operatorCatalogModel.ts';
import type {
  DepotSnapshot,
  MaterialFormula,
  MaterialFormulas,
  OperBoxData,
  OperatorMaterialData,
  OperatorMaterialsFile,
  OwnedOperator,
  TrainingElitePlan,
  TrainingFlowMode,
  TrainingMaterialDefinition,
  TrainingMaterialRequirement,
  TrainingMaterialsDatabase,
  TrainingSettings
} from './operatorTrainingModel.ts';

const logger = createLogger('OperatorTraining');

// 配置文件路径：与抓取脚本共用运行配置入口，默认 server/data，
// 可由 LA_PLUMA_TRAINING_DATA_DIR 重定向。
const DATA_DIRECTORY = resolveAppPaths().trainingDataDir;
const TRAINING_QUEUE_PATH = path.join(DATA_DIRECTORY, 'user-configs/training-queue.json');
const COMBAT_TASKS_PATH = path.join(DATA_DIRECTORY, 'user-configs/automation-tasks.json');
const OPERATOR_MATERIALS_PATH = path.join(DATA_DIRECTORY, 'operator-materials.json');
const OPERBOX_PATH = path.join(DATA_DIRECTORY, 'operbox.json');
const DEPOT_PATH = path.join(DATA_DIRECTORY, 'depot.json');

export interface TrainingFlowBinding {
  taskId?: string;
  taskName?: string;
  flowName?: string;
  mode?: TrainingFlowMode;
  status?: 'synced' | 'failed';
  syncedRevision?: string;
  error?: string;
}

export interface TrainingQueueItem {
  operatorId: string;
  currentElite?: number;
  targetElite?: number;
  priority?: number;
  status?: string;
  addedAt?: string;
  [extension: string]: unknown;
}

/** 持久队列及其设置；未知顶层字段原样保留以便回写。 */
export interface TrainingQueueData {
  queue: TrainingQueueItem[];
  settings: TrainingSettings;
  lastUpdated: string;
  trainingFlow?: TrainingFlowBinding;
  flowSyncError?: string;
  [extension: string]: unknown;
}

export interface CombatStageObject {
  stage?: string;
  times?: string;
  smart?: boolean;
  pinned?: boolean;
  trainingOperators?: string[];
  [extension: string]: unknown;
}

export type CombatTaskStage = string | CombatStageObject;

/** automation-tasks.json 中 fight 任务读取的字段；其余字段原样保留。 */
export interface CombatTaskParams {
  stage?: string;
  stages?: CombatTaskStage[];
  medicine?: number;
  medicineExpireDays?: number;
  stone?: number;
  series?: number;
  [extension: string]: unknown;
}

export interface CombatTask {
  id?: string;
  name?: string;
  description?: string;
  commandId?: string;
  enabled?: boolean;
  params?: CombatTaskParams;
  [extension: string]: unknown;
}

export interface CombatSchedule {
  enabled?: boolean;
  times?: unknown[];
  [extension: string]: unknown;
}

/** automation-tasks.json 的读取视图；写入时整体回写，不丢弃未知字段。 */
export interface CombatTasksConfig {
  name?: string;
  flowName?: string;
  taskFlow: CombatTask[];
  schedule?: CombatSchedule;
  [extension: string]: unknown;
}

export function isCombatStageObject(stage: CombatTaskStage): stage is CombatStageObject {
  return typeof stage === 'object' && stage !== null;
}

// Keep read-modify-write operations together, including the flow synchronization.
let trainingMutation: Promise<unknown> = Promise.resolve();
export function serializeTrainingMutation<T>(operation: () => Promise<T>): Promise<T> {
  const current = trainingMutation.catch(() => undefined).then(operation);
  trainingMutation = current;
  return current;
}

function parseQueueItem(value: unknown): TrainingQueueItem | null {
  if (!isRecord(value) || typeof value.operatorId !== 'string' || value.operatorId.length === 0) {
    return null;
  }
  const item: TrainingQueueItem = { operatorId: value.operatorId };
  if (typeof value.currentElite === 'number' && Number.isFinite(value.currentElite)) {
    item.currentElite = value.currentElite;
  }
  if (typeof value.targetElite === 'number' && Number.isFinite(value.targetElite)) {
    item.targetElite = value.targetElite;
  }
  if (typeof value.priority === 'number' && Number.isFinite(value.priority)) {
    item.priority = value.priority;
  }
  if (typeof value.status === 'string') item.status = value.status;
  if (typeof value.addedAt === 'string') item.addedAt = value.addedAt;
  return item;
}

function parseTrainingFlow(value: unknown): TrainingFlowBinding | null {
  if (!isRecord(value)) return null;
  const binding: TrainingFlowBinding = {};
  if (typeof value.taskId === 'string') binding.taskId = value.taskId;
  if (typeof value.taskName === 'string') binding.taskName = value.taskName;
  if (typeof value.flowName === 'string') binding.flowName = value.flowName;
  if (value.mode === 'current' || value.mode === 'all') binding.mode = value.mode;
  if (value.status === 'synced' || value.status === 'failed') binding.status = value.status;
  if (typeof value.syncedRevision === 'string') binding.syncedRevision = value.syncedRevision;
  if (typeof value.error === 'string') binding.error = value.error;
  return binding;
}

/**
 * 校验并规范化持久队列：缺少 operatorId 的条目忽略，字段类型不符回退默认值；
 * JSON 语法错误仍由 readJsonFile 抛出，不在这里吞掉。
 */
export function parseTrainingQueue(value: unknown): TrainingQueueData {
  const record = isRecord(value) ? value : {};
  const rawQueue = Array.isArray(record.queue) ? record.queue : [];
  const queue: TrainingQueueItem[] = [];
  for (const entry of rawQueue) {
    const item = parseQueueItem(entry);
    if (item) queue.push(item);
  }
  if (queue.length !== rawQueue.length) {
    logger.warn('养成队列存在格式不符的条目，已忽略', { skipped: rawQueue.length - queue.length });
  }

  const data: TrainingQueueData = {
    ...record,
    queue,
    settings: normalizeTrainingSettings(record.settings),
    lastUpdated: typeof record.lastUpdated === 'string'
      ? record.lastUpdated
      : new Date().toISOString()
  };

  const trainingFlow = parseTrainingFlow(record.trainingFlow);
  if (trainingFlow) data.trainingFlow = trainingFlow;
  else delete data.trainingFlow;
  if (typeof record.flowSyncError === 'string') data.flowSyncError = record.flowSyncError;
  else delete data.flowSyncError;

  return data;
}

export function getQueueRevision(queueData: TrainingQueueData): string {
  return createHash('sha256').update(JSON.stringify(queueData.queue.map(item => ({
    operatorId: item.operatorId,
    currentElite: item.currentElite ?? 0,
    targetElite: item.targetElite ?? 2
  })))).digest('hex');
}

export async function loadTrainingQueue(): Promise<TrainingQueueData> {
  const defaultQueue: TrainingQueueData = {
    queue: [],
    settings: { ...DEFAULT_TRAINING_SETTINGS },
    lastUpdated: new Date().toISOString()
  };

  const queueData = await readJsonFile(TRAINING_QUEUE_PATH, defaultQueue);
  return parseTrainingQueue(queueData);
}

export async function saveTrainingQueue(queueData: TrainingQueueData): Promise<true> {
  try {
    queueData.lastUpdated = new Date().toISOString();
    await writeJsonFile(TRAINING_QUEUE_PATH, queueData);
    return true;
  } catch (error) {
    logger.error('保存养成队列失败', { error: errorMessage(error) });
    throw error;
  }
}

function parseMaterialRequirements(value: unknown): TrainingMaterialRequirement[] {
  if (!Array.isArray(value)) return [];
  const requirements: TrainingMaterialRequirement[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { id, name, count } = entry;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    requirements.push({ id, name, count });
  }
  return requirements;
}

function parseElitePlan(value: unknown): TrainingElitePlan | null {
  if (!isRecord(value)) return null;
  const plan: TrainingElitePlan = {};
  if (typeof value.lmd === 'number' && Number.isFinite(value.lmd)) plan.lmd = value.lmd;
  const materials = parseMaterialRequirements(value.materials);
  if (materials.length > 0) plan.materials = materials;
  const chips = parseMaterialRequirements(value.chips);
  if (chips.length > 0) plan.chips = chips;
  return plan;
}

function parseOperatorMaterial(value: unknown): OperatorMaterialData | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const operator: OperatorMaterialData = { name: value.name };
  if (typeof value.id === 'string') operator.id = value.id;
  if (typeof value.rarity === 'number' && Number.isFinite(value.rarity)) operator.rarity = value.rarity;
  if (typeof value.profession === 'string') operator.profession = value.profession;
  const elite1 = parseElitePlan(value.elite1);
  if (elite1) operator.elite1 = elite1;
  const elite2 = parseElitePlan(value.elite2);
  if (elite2) operator.elite2 = elite2;
  return operator;
}

/**
 * 校验 operator-materials.json：缺少字符串 name 的干员与字段类型不符的材料条目
 * 被忽略（该干员按缺少数据或材料不完整处理），整个文件结构不符时返回空表。
 */
export function parseOperatorMaterials(value: unknown): OperatorMaterialsFile {
  if (!isRecord(value) || !isRecord(value.operators)) return { operators: {}, metadata: {} };
  const operators: Record<string, OperatorMaterialData> = {};
  let skipped = 0;
  for (const [id, raw] of Object.entries(value.operators)) {
    const parsed = parseOperatorMaterial(raw);
    if (parsed) operators[id] = parsed;
    else skipped += 1;
  }
  if (skipped > 0) logger.warn('干员材料数据存在格式不符的条目，已忽略', { skipped });
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : {};
  return { operators, metadata };
}

export async function loadOperatorMaterials(): Promise<OperatorMaterialsFile> {
  try {
    const data = await readJsonFile(OPERATOR_MATERIALS_PATH, { operators: {}, metadata: {} });
    return parseOperatorMaterials(data);
  } catch (error) {
    logger.error('加载干员材料数据失败', { error: errorMessage(error) });
    return { operators: {}, metadata: {} };
  }
}

function parseMaterialDefinition(value: unknown): TrainingMaterialDefinition | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const material: TrainingMaterialDefinition = { name: value.name };
  if (typeof value.id === 'string') material.id = value.id;
  if (typeof value.rarity === 'number' && Number.isFinite(value.rarity)) material.rarity = value.rarity;
  if (typeof value.iconId === 'string') material.iconId = value.iconId;
  if (typeof value.bestStage === 'string') material.bestStage = value.bestStage;
  if (Array.isArray(value.bestStages)) {
    const bestStages: { stage: string }[] = [];
    for (const entry of value.bestStages) {
      if (isRecord(entry) && typeof entry.stage === 'string') bestStages.push({ stage: entry.stage });
    }
    if (bestStages.length > 0) material.bestStages = bestStages;
  }
  return material;
}

/**
 * 校验 materials.json：materials 表逐条校验（缺少 name 的条目忽略），
 * recipes 与 stageSchedule 只保留为计数用的记录。
 */
export function parseMaterialsDatabase(value: unknown): TrainingMaterialsDatabase {
  if (!isRecord(value) || !isRecord(value.materials)) {
    return { materials: {}, recipes: {}, stageSchedule: {} };
  }
  const materials: Record<string, TrainingMaterialDefinition> = {};
  let skipped = 0;
  for (const [id, raw] of Object.entries(value.materials)) {
    const material = parseMaterialDefinition(raw);
    if (material) materials[id] = material;
    else skipped += 1;
  }
  if (skipped > 0) logger.warn('材料数据库存在格式不符的条目，已忽略', { skipped });
  return {
    materials,
    recipes: isRecord(value.recipes) ? { ...value.recipes } : {},
    stageSchedule: isRecord(value.stageSchedule) ? { ...value.stageSchedule } : {}
  };
}

/** 本地资源缺失或字段不符时抛出；调用方必须显式处理，不能按空数据继续。 */
export class LocalResourceError extends Error {
  code: string;
  resourcePath: string;
  field?: string;

  constructor(
    message: string,
    resourcePath: string,
    field?: string,
    code: string = 'LOCAL_RESOURCE_INVALID'
  ) {
    super(message);
    this.name = 'LocalResourceError';
    this.code = code;
    this.resourcePath = resourcePath;
    if (field !== undefined) this.field = field;
  }
}

interface LocalJsonCacheEntry {
  signature: string;
  value: unknown;
}

const localJsonCache = new Map<string, LocalJsonCacheEntry>();

/** 仅供测试隔离；生产进程按文件 mtime/size 自然失效，不主动清缓存。 */
export function resetLocalResourceCacheForTests(): void {
  localJsonCache.clear();
}

async function readLocalResourceJson(resourcePath: string): Promise<unknown> {
  let signature: string;
  try {
    const fileStat = await stat(resourcePath);
    signature = `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    throw new LocalResourceError(
      `本地资源文件缺失: ${resourcePath}`,
      resourcePath,
      undefined,
      'LOCAL_RESOURCE_MISSING'
    );
  }

  const cached = localJsonCache.get(resourcePath);
  if (cached?.signature === signature) return cached.value;

  let content: string;
  try {
    content = await readFile(resourcePath, 'utf8');
  } catch {
    throw new LocalResourceError(`本地资源文件不可读: ${resourcePath}`, resourcePath);
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new LocalResourceError(`本地资源文件不是合法 JSON: ${resourcePath}`, resourcePath);
  }

  localJsonCache.set(resourcePath, { signature, value });
  return value;
}

async function readOptionalLocalResourceJson(resourcePath: string): Promise<unknown | null> {
  try {
    return await readLocalResourceJson(resourcePath);
  } catch (error) {
    if (error instanceof LocalResourceError && error.code === 'LOCAL_RESOURCE_MISSING') return null;
    throw error;
  }
}

function iconIdFromFilename(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const basename = path.basename(value);
  return basename.toLowerCase().endsWith('.png') ? basename.slice(0, -4) : basename;
}

function parseLocalMaterialEntry(
  id: string,
  raw: unknown,
  resourcePath: string,
  field: string
): TrainingMaterialDefinition | null {
  if (!isRecord(raw)) return null;
  const kind = raw.itemType ?? raw.classifyType;
  if (typeof kind === 'string' && kind !== 'MATERIAL') return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new LocalResourceError(`本地资源字段缺失: ${resourcePath} 的 ${field}.name`, resourcePath, `${field}.name`);
  }

  const material: TrainingMaterialDefinition = { id, name: raw.name };
  if (typeof raw.rarity === 'number' && Number.isFinite(raw.rarity)) material.rarity = raw.rarity;
  const iconId = iconIdFromFilename(raw.iconId ?? raw.icon);
  if (iconId !== undefined) material.iconId = iconId;
  return material;
}

function readFormula(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const materials: Record<string, number> = {};
  for (const [materialId, quantity] of Object.entries(value)) {
    if (typeof quantity === 'number' && Number.isFinite(quantity)) materials[materialId] = quantity;
  }
  return Object.keys(materials).length > 0 ? materials : null;
}

interface LocalMaterialSource {
  materials: Record<string, TrainingMaterialDefinition>;
  recipes: MaterialFormulas;
}

async function loadLocalMaterialSource(): Promise<LocalMaterialSource> {
  const itemTablePath = await resolveEffectiveResourceFilePath(path.join('gamedata', 'excel', 'item_table.json'));
  const itemIndexPath = await resolveEffectiveResourceFilePath(path.join('item_index.json'));
  const itemTable = await readOptionalLocalResourceJson(itemTablePath);
  const itemIndex = await readOptionalLocalResourceJson(itemIndexPath);

  if (itemTable === null && itemIndex === null) {
    throw new LocalResourceError(
      `本地资源缺失: 未找到 ${itemTablePath} 或 ${itemIndexPath}，请先同步 MAA 资源`,
      itemTablePath,
      undefined,
      'LOCAL_RESOURCE_MISSING'
    );
  }

  let entries: Record<string, unknown>;
  let materialPath: string;
  if (itemTable !== null) {
    if (!isRecord(itemTable) || !isRecord(itemTable.items)) {
      throw new LocalResourceError(`本地资源字段缺失: ${itemTablePath} 的 items`, itemTablePath, 'items');
    }
    entries = itemTable.items;
    materialPath = itemTablePath;
  } else {
    if (!isRecord(itemIndex)) {
      throw new LocalResourceError(`本地资源字段缺失: ${itemIndexPath} 的 items`, itemIndexPath, 'items');
    }
    entries = itemIndex;
    materialPath = itemIndexPath;
  }

  const materials: Record<string, TrainingMaterialDefinition> = {};
  for (const [id, raw] of Object.entries(entries)) {
    const material = parseLocalMaterialEntry(id, raw, materialPath, itemTable === null ? id : `items.${id}`);
    if (material) materials[id] = material;
  }
  if (Object.keys(materials).length === 0) {
    throw new LocalResourceError(`本地资源字段缺失: ${materialPath} 没有可用材料条目`, materialPath, 'items');
  }

  const recipes: MaterialFormulas = {};
  const collectRecipes = (source: unknown): void => {
    if (!isRecord(source)) return;
    const table = isRecord(source.items) ? source.items : source;
    for (const [id, raw] of Object.entries(table)) {
      if (!isRecord(raw)) continue;
      const formula = readFormula(raw.formula);
      if (formula) recipes[id] = { materials: formula };
    }
  };
  collectRecipes(itemTable);
  collectRecipes(itemIndex);

  return { materials, recipes };
}

async function loadTrainingSnapshotExtras(): Promise<{
  bestStages: Record<string, Partial<TrainingMaterialDefinition>>;
  stageSchedule: Record<string, unknown>;
}> {
  const snapshotPath = path.join(DATA_DIRECTORY, 'materials.json');
  let snapshot: unknown;
  try {
    snapshot = await readJsonFile(snapshotPath, null);
  } catch {
    return { bestStages: {}, stageSchedule: {} };
  }
  if (!isRecord(snapshot)) return { bestStages: {}, stageSchedule: {} };

  const bestStages: Record<string, Partial<TrainingMaterialDefinition>> = {};
  if (isRecord(snapshot.materials)) {
    for (const [id, raw] of Object.entries(snapshot.materials)) {
      if (!isRecord(raw)) continue;
      const extra: Partial<TrainingMaterialDefinition> = {};
      if (typeof raw.bestStage === 'string') extra.bestStage = raw.bestStage;
      if (Array.isArray(raw.bestStages)) {
        const stages: { stage: string }[] = [];
        for (const entry of raw.bestStages) {
          if (isRecord(entry) && typeof entry.stage === 'string') stages.push({ stage: entry.stage });
        }
        if (stages.length > 0) extra.bestStages = stages;
      }
      if (Object.keys(extra).length > 0) bestStages[id] = extra;
    }
  }

  return {
    bestStages,
    stageSchedule: isRecord(snapshot.stageSchedule) ? { ...snapshot.stageSchedule } : {}
  };
}

export async function loadMaterialsDatabase(): Promise<TrainingMaterialsDatabase> {
  const source = await loadLocalMaterialSource();
  const extras = await loadTrainingSnapshotExtras();
  for (const [id, extra] of Object.entries(extras.bestStages)) {
    const material = source.materials[id];
    if (!material) continue;
    if (extra.bestStage !== undefined) material.bestStage = extra.bestStage;
    if (extra.bestStages !== undefined) material.bestStages = extra.bestStages;
  }
  return {
    materials: source.materials,
    recipes: source.recipes,
    stageSchedule: extras.stageSchedule
  };
}

/**
 * 校验 material-formulas.json：只保留配方对象中数量为有限数值的子材料。
 */
export function parseMaterialFormulas(value: unknown): MaterialFormulas {
  if (!isRecord(value)) return {};
  const formulas: MaterialFormulas = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const formula: MaterialFormula = {};
    if (isRecord(raw.materials)) {
      const materials: Record<string, number> = {};
      for (const [materialId, quantity] of Object.entries(raw.materials)) {
        if (typeof quantity === 'number' && Number.isFinite(quantity)) materials[materialId] = quantity;
      }
      formula.materials = materials;
    }
    formulas[id] = formula;
  }
  return formulas;
}

export async function loadMaterialFormulas(): Promise<MaterialFormulas> {
  return (await loadLocalMaterialSource()).recipes;
}

function parseOwnedOperator(value: unknown): OwnedOperator | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  const operator: OwnedOperator = { id: value.id };
  if (typeof value.name === 'string') operator.name = value.name;
  if (typeof value.rarity === 'number' && Number.isFinite(value.rarity)) operator.rarity = value.rarity;
  if (typeof value.profession === 'string') operator.profession = value.profession;
  if (typeof value.elite === 'number' && Number.isFinite(value.elite)) operator.elite = value.elite;
  if (typeof value.level === 'number' && Number.isFinite(value.level)) operator.level = value.level;
  if (typeof value.potential === 'number' && Number.isFinite(value.potential)) {
    operator.potential = value.potential;
  }
  if (typeof value.own === 'boolean') operator.own = value.own;
  return operator;
}

function parseOwnedOperators(value: unknown): OwnedOperator[] {
  if (!Array.isArray(value)) return [];
  const operators: OwnedOperator[] = [];
  for (const entry of value) {
    const operator = parseOwnedOperator(entry);
    if (operator) operators.push(operator);
  }
  return operators;
}

/**
 * 校验 OperBox 文件：保留原信封（`data` 或 `operators`），逐条校验干员；
 * 识别目录与目录总数只在存在时读取，旧快照仍按已识别拥有列表可用。
 */
export function parseOperBox(value: unknown): OperBoxData {
  const record = isRecord(value) ? value : {};
  const data: OperBoxData = Array.isArray(record.data)
    ? { data: parseOwnedOperators(record.data) }
    : { operators: Array.isArray(record.operators) ? parseOwnedOperators(record.operators) : [] };

  const allOpers = parseOperBoxCatalog(record.allOpers);
  if (allOpers && allOpers.length > 0) data.allOpers = allOpers;
  if (typeof record.operTotal === 'number' && Number.isFinite(record.operTotal)) {
    data.operTotal = record.operTotal;
  }
  if (typeof record.timestamp === 'string') data.timestamp = record.timestamp;
  return data;
}

/** 读取持有干员快照；文件缺失或损坏返回 null，由调用方区分为“尚未识别”。 */
export async function loadOperBox(): Promise<OperBoxData | null> {
  try {
    const data = await readJsonFile(OPERBOX_PATH, null);
    if (data === null) return null;
    return parseOperBox(data);
  } catch (error) {
    logger.error('加载 OperBox 数据失败', { error: errorMessage(error) });
    return null;
  }
}

/**
 * 校验 depot.json：items 数组按 id 建索引，缺少 id 或数量非有限数值的条目忽略。
 */
export function parseDepot(value: unknown): DepotSnapshot {
  const record = isRecord(value) ? value : {};
  const items: Record<string, number> = {};
  if (Array.isArray(record.items)) {
    for (const entry of record.items) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      if (typeof entry.count !== 'number' || !Number.isFinite(entry.count)) continue;
      items[entry.id] = entry.count;
    }
  }
  return {
    items,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null
  };
}

export async function loadDepot(): Promise<DepotSnapshot> {
  try {
    const data = await readJsonFile(DEPOT_PATH, { items: [], timestamp: null });
    return parseDepot(data);
  } catch (error) {
    logger.error('加载仓库数据失败', { error: errorMessage(error) });
    return { items: {}, timestamp: null };
  }
}

function isCombatTask(value: unknown): value is CombatTask {
  if (!isRecord(value)) return false;
  const { params } = value;
  if (params === undefined) return true;
  if (!isRecord(params)) return false;
  if (params.stages === undefined) return true;
  if (!Array.isArray(params.stages)) return false;
  return params.stages.every(stage => typeof stage === 'string' || isRecord(stage));
}

function parseCombatTask(value: unknown): CombatTask {
  if (!isCombatTask(value)) throw new Error('自动化任务配置格式无效');
  // 结构已校验；保留原始对象引用，回写时不丢失本领域未读取的字段。
  return value;
}

/**
 * 校验 automation-tasks.json 的最小结构（对象、taskFlow 数组、各任务 params/stages
 * 形态）；通过后保留原对象整体回写，格式无效即抛错，调用方保留部分成功结果、不覆盖原文件。
 */
export function parseCombatTasksConfig(value: unknown): CombatTasksConfig {
  if (!isRecord(value)) throw new Error('自动化任务配置格式无效');
  const rawTaskFlow = value.taskFlow;
  if (rawTaskFlow !== undefined && !Array.isArray(rawTaskFlow)) {
    throw new Error('自动化任务配置格式无效');
  }
  const taskFlow = (rawTaskFlow ?? []).map(entry => parseCombatTask(entry));
  return { ...value, taskFlow };
}

/**
 * 读取自动化任务配置；缺失或损坏时使用调用方给出的默认结构。
 */
export async function readCombatTasksConfig(
  defaultValue: unknown = { taskFlow: [] }
): Promise<CombatTasksConfig> {
  const data = await readJsonFile(COMBAT_TASKS_PATH, defaultValue);
  return parseCombatTasksConfig(data);
}

/**
 * 串行读改写自动化任务配置。写入与其它同文件写入共用 fileHelper 的路径级队列；
 * 回调收到未经校验的读取值，须先用 parseCombatTasksConfig 校验再返回配置。
 */
export async function updateCombatTasksConfig(
  updateFn: (config: unknown) => CombatTasksConfig | Promise<CombatTasksConfig>,
  defaultValue: unknown
): Promise<CombatTasksConfig> {
  return updateJsonFile(COMBAT_TASKS_PATH, updateFn, defaultValue);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
