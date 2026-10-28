/**
 * 养成领域持久化
 *
 * 训练队列的读取、写入、写入串行化与 queueRevision，以及养成所需的游戏数据快照
 * （干员材料、材料库、合成配方、OperBox、仓库）和自动化任务配置的读写。
 *
 * 这里是该领域文件访问的唯一入口：领域命令与应用同步通过本模块读写，不自行拼路径。
 * 所有 JSON 读取结果先经本模块的解析函数校验为领域类型，损坏或结构不符的条目
 * 按各自策略回退（见各 load/parse 函数），不会以 unknown 进入计算。
 * 材料需求与设置归一化等纯计算在 operatorTrainingModel。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonFile, updateJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';
import {
  DEFAULT_TRAINING_SETTINGS,
  isRecord,
  normalizeTrainingSettings
} from './operatorTrainingModel.ts';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建日志记录器
const logger = createLogger('OperatorTraining');

// 配置文件路径
const DATA_DIRECTORY = process.env.LA_PLUMA_TRAINING_DATA_DIR || path.join(__dirname, '../data');
const TRAINING_QUEUE_PATH = path.join(DATA_DIRECTORY, 'user-configs/training-queue.json');
const COMBAT_TASKS_PATH = path.join(DATA_DIRECTORY, 'user-configs/automation-tasks.json');
const OPERATOR_MATERIALS_PATH = path.join(DATA_DIRECTORY, 'operator-materials.json');
const OPERBOX_PATH = path.join(DATA_DIRECTORY, 'operbox.json');
const DEPOT_PATH = path.join(DATA_DIRECTORY, 'depot.json');

/** 已应用的训练流程绑定。 */
export interface TrainingFlowBinding {
  taskId?: string;
  taskName?: string;
  flowName?: string;
  mode?: TrainingFlowMode;
  status?: 'synced' | 'failed';
  syncedRevision?: string;
  error?: string;
}

/** training-queue.json 中的单个队列条目。 */
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

/** automation-tasks.json 中的关卡条目：字符串关卡或带开关的对象。 */
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
  expiringMedicine?: number;
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

/** 判断关卡条目是否为带开关的对象（字符串关卡不参与 smart/pinned 分类）。 */
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
 * 校验并规范化持久队列：缺少 operatorId 的条目忽略，数字/布尔字段类型不符时
 * 回退读取方默认值（`currentElite ?? 0`、`targetElite ?? 2`）。JSON 语法错误仍由
 * readJsonFile 抛出，不在这里吞掉。
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

/**
 * 加载养成队列（默认设置与旧结构归一化在读取时完成）
 */
export async function loadTrainingQueue(): Promise<TrainingQueueData> {
  const defaultQueue: TrainingQueueData = {
    queue: [],
    settings: { ...DEFAULT_TRAINING_SETTINGS },
    lastUpdated: new Date().toISOString()
  };

  const queueData = await readJsonFile(TRAINING_QUEUE_PATH, defaultQueue);
  return parseTrainingQueue(queueData);
}

/**
 * 保存养成队列
 */
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

/**
 * 加载干员材料数据库
 */
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

/**
 * 加载材料数据库（包含 recipes）
 */
export async function loadMaterialsDatabase(): Promise<TrainingMaterialsDatabase> {
  try {
    const MATERIALS_DB_PATH = path.join(DATA_DIRECTORY, 'materials.json');
    const data = await readJsonFile(MATERIALS_DB_PATH, { materials: {}, recipes: {}, stageSchedule: {} });
    return parseMaterialsDatabase(data);
  } catch (error) {
    logger.error('加载材料数据库失败', { error: errorMessage(error) });
    return { materials: {}, recipes: {}, stageSchedule: {} };
  }
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

/**
 * 加载材料合成配方数据库
 */
export async function loadMaterialFormulas(): Promise<MaterialFormulas> {
  try {
    const FORMULAS_PATH = path.join(DATA_DIRECTORY, 'material-formulas.json');
    const data = await readJsonFile(FORMULAS_PATH, {});
    return parseMaterialFormulas(data);
  } catch (error) {
    logger.error('加载材料合成配方失败', { error: errorMessage(error) });
    return {};
  }
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
 * 校验 OperBox 文件：保留原信封（`data` 或 `operators`），逐条校验干员。
 */
export function parseOperBox(value: unknown): OperBoxData {
  const record = isRecord(value) ? value : {};
  if (Array.isArray(record.data)) return { data: parseOwnedOperators(record.data) };
  if (Array.isArray(record.operators)) return { operators: parseOwnedOperators(record.operators) };
  return { operators: [] };
}

/**
 * 加载 OperBox 识别结果
 */
export async function loadOperBox(): Promise<OperBoxData> {
  try {
    const data = await readJsonFile(OPERBOX_PATH, { operators: [] });
    return parseOperBox(data);
  } catch (error) {
    logger.error('加载 OperBox 数据失败', { error: errorMessage(error) });
    return { operators: [] };
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

/**
 * 加载仓库数据
 */
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
 * 校验 automation-tasks.json 的最小结构：必须是对象，taskFlow 为数组，
 * 每个任务的 params/stages 形态合法。校验通过后保留原对象，写入时整体回写；
 * 格式无效时抛错，调用方保留队列与流程的部分成功结果，不覆盖原文件。
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

/** 已知错误取 message，其余值转为字符串；日志与错误字段不写入 undefined。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
