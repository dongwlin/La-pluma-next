/**
 * 干员养成领域接口
 *
 * 候选干员投影、队列读取与队列命令、计划生成/应用的对外入口，以及材料数据抓取。
 * 领域内的职责分工：
 * - 纯计算与设置有效性：operatorTrainingModel
 * - 刷取计划与掉落估算：operatorTrainingPlan
 * - 队列与游戏数据持久化：operatorTrainingStore
 * - 计划应用与流程/定时同步：operatorTrainingApplication
 *
 * 队列写入按 `serializeTrainingMutation` 串行，流程同步与应用计划复用同一把锁；
 * 接口仍只由本服务提供，不暴露可被其它模块直接改写的队列对象。
 * 队列命令的入参来自 HTTP 请求体，进入持久化前按领域类型校验。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { getAllOperators } from './dataParserService.ts';
import {
  buildTrainingCandidates,
  calculateOperatorMaterials,
  calculateProgress,
  getOperBoxOperators,
  isRecord,
  normalizeTrainingSettings,
  trainingError
} from './operatorTrainingModel.ts';
import type {
  LmdRequirement,
  MaterialCalculation,
  TrainingBaseOperator,
  TrainingCandidate,
  TrainingMaterialNeed,
  TrainingOperatorFilters,
  TrainingOperatorRequirements,
  TrainingSettings
} from './operatorTrainingModel.ts';
import {
  getQueueRevision,
  loadDepot,
  loadOperatorMaterials,
  loadOperBox,
  loadMaterialsDatabase,
  loadTrainingQueue,
  saveTrainingQueue,
  serializeTrainingMutation
} from './operatorTrainingStore.ts';
import type { TrainingQueueItem } from './operatorTrainingStore.ts';
import { generateTrainingPlan } from './operatorTrainingPlan.ts';
import type { TrainingPlan } from './operatorTrainingPlan.ts';
import {
  applyPlanToTasks,
  finishQueueMutation,
  getQueueFlowSync,
  syncTrainingFlow
} from './operatorTrainingApplication.ts';
import type {
  ApplyPlanOptions,
  ApplyPlanResult,
  FlowSyncState,
  QueueMutationResult,
  TrainingFlowSyncResult
} from './operatorTrainingApplication.ts';

export { expandMaterialTree, estimateMaterialFarming } from './operatorTrainingPlan.ts';
export { summarizeScheduleSync } from './operatorTrainingApplication.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建日志记录器
const logger = createLogger('OperatorTraining');

/** 队列条目的响应投影：附带材料需求、进度与干员摘要。 */
export interface TrainingQueueItemDetail extends TrainingQueueItem {
  operator: {
    id: string;
    name: string;
    rarity?: number;
    profession?: string;
  };
  materials: TrainingMaterialNeed[];
  lmd: LmdRequirement;
  isComplete: boolean;
  progress: number;
}

/** `/training/queue` 的响应载荷。 */
export interface TrainingQueueSnapshot {
  queue: TrainingQueueItemDetail[];
  settings: TrainingSettings;
  lastUpdated: string;
  revision: string;
  flowSync: FlowSyncState;
}

/** 入队选项：来自请求体的值经有限数值校验后写入队列。 */
export interface QueueAddOptions {
  currentElite?: number;
  targetElite?: number;
  position?: number;
}

/** 单个材料抓取脚本的配置。 */
interface MaterialFetchScriptConfig {
  name: string;
  script: string;
  output: string;
}

/** 单个抓取脚本的执行结果。 */
export interface MaterialFetchScriptResult {
  name: string;
  script: string;
  output: string;
  success: boolean;
  durationMs: number;
  entries?: number | null;
  error?: string;
}

/** `/actions/fetch-training-materials` 的响应载荷。 */
export interface MaterialFetchSummary {
  scripts: MaterialFetchScriptResult[];
  operatorCount: number;
  materialCount: number;
  recipeCount: number;
  lastUpdated: string;
}

/** 领域接口：路由与调度经此调用养成能力。 */
export interface OperatorTrainingService {
  getOperatorList(filters?: TrainingOperatorFilters): Promise<TrainingCandidate[]>;
  getTrainingQueue(): Promise<TrainingQueueSnapshot>;
  addToQueue(operatorId: string, options?: QueueAddOptions): Promise<QueueMutationResult & TrainingQueueItem>;
  removeFromQueue(operatorId: string): Promise<QueueMutationResult>;
  updateQueueOrder(orderedOperatorIds: unknown): Promise<QueueMutationResult>;
  updateSettings(settings: unknown): Promise<TrainingSettings>;
  syncTrainingFlow(): Promise<TrainingFlowSyncResult>;
  generateTrainingPlan(mode?: string): Promise<TrainingPlan>;
  applyPlanToTasks(plan: unknown, settings?: unknown, options?: ApplyPlanOptions): Promise<ApplyPlanResult>;
  calculateOperatorMaterials(
    operator: TrainingOperatorRequirements,
    depot?: Record<string, number>
  ): MaterialCalculation;
  fetchOperatorMaterials(): Promise<MaterialFetchSummary>;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 已知错误取 message，其余值转为字符串。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 获取干员列表（全量干员为主，OperBox 和材料数据库补充养成状态）
 */
async function getOperatorList(filters: TrainingOperatorFilters = {}): Promise<TrainingCandidate[]> {
  const operatorMaterialsData = await loadOperatorMaterials();
  const operBoxData = await loadOperBox();

  const ownedOperators = getOperBoxOperators(operBoxData);
  let allOperators: TrainingBaseOperator[] = [];

  try {
    allOperators = await getAllOperators();
  } catch (error) {
    logger.warn('加载全量干员失败，降级为仅显示已识别干员', { error: errorMessage(error) });
    allOperators = ownedOperators.map(operator => ({
      id: operator.id,
      name: operator.name ?? operator.id,
      rarity: operator.rarity ?? 0,
      profession: operator.profession || '未知'
    }));
  }

  return buildTrainingCandidates(allOperators, ownedOperators, operatorMaterialsData, filters);
}

/**
 * 获取养成队列
 */
async function getTrainingQueue(): Promise<TrainingQueueSnapshot> {
  const queueData = await loadTrainingQueue();
  const depot = await loadDepot();
  const operatorMaterialsData = await loadOperatorMaterials();

  // 为队列中的每个干员计算材料需求和进度
  const enrichedQueue: TrainingQueueItemDetail[] = [];

  for (const queueItem of queueData.queue) {
    const opData = operatorMaterialsData.operators[queueItem.operatorId];
    if (!opData) continue;

    const operator: TrainingOperatorRequirements = {
      id: queueItem.operatorId,
      name: opData.name,
      rarity: opData.rarity,
      profession: opData.profession,
      currentElite: queueItem.currentElite ?? 0,
      targetElite: queueItem.targetElite ?? 2,
      materials: {
        elite1: opData.elite1,
        elite2: opData.elite2
      }
    };

    const materialCalc = calculateOperatorMaterials(operator, depot.items);

    enrichedQueue.push({
      ...queueItem,
      operator: {
        id: operator.id,
        name: opData.name,
        rarity: opData.rarity,
        profession: opData.profession
      },
      materials: materialCalc.materials,
      lmd: materialCalc.lmd,
      isComplete: materialCalc.isComplete,
      progress: calculateProgress(materialCalc)
    });
  }

  return {
    queue: enrichedQueue,
    settings: queueData.settings,
    lastUpdated: queueData.lastUpdated,
    revision: getQueueRevision(queueData),
    flowSync: await getQueueFlowSync(queueData)
  };
}

/**
 * 添加干员到养成队列
 */
async function addToQueue(
  operatorId: string,
  options: QueueAddOptions = {}
): Promise<QueueMutationResult & TrainingQueueItem> {
  const queueData = await loadTrainingQueue();
  const operatorMaterialsData = await loadOperatorMaterials();
  const operBoxData = await loadOperBox();

  const opData = operatorMaterialsData.operators[operatorId];
  if (!opData) {
    throw new Error(`干员材料数据不存在，暂不支持该干员`);
  }

  // 从 OperBox 获取干员名称
  const operBoxOp = getOperBoxOperators(operBoxData).find(op => op.id === operatorId);
  const operatorName = operBoxOp?.name || opData.name;

  // 检查是否已在队列中
  const existingIndex = queueData.queue.findIndex(item => item.operatorId === operatorId);
  if (existingIndex !== -1) {
    throw new Error(`干员 ${operatorName} 已在养成队列中`);
  }

  // 添加到队列
  const queueItem: TrainingQueueItem = {
    operatorId,
    currentElite: toFiniteNumber(options.currentElite) ?? operBoxOp?.elite ?? 0,
    targetElite: toFiniteNumber(options.targetElite) ?? 2,
    priority: queueData.queue.length + 1,
    status: 'pending',
    addedAt: new Date().toISOString()
  };

  const position = options.position ?? queueData.queue.length;
  if (!Number.isInteger(position) || position < 0 || position > queueData.queue.length) {
    throw trainingError('position 必须是有效的队列位置');
  }
  queueData.queue.splice(position, 0, queueItem);
  queueData.queue.forEach((item, index) => { item.priority = index + 1; });
  return finishQueueMutation(queueData, queueItem);
}

/**
 * 从养成队列中移除干员
 */
async function removeFromQueue(operatorId: string): Promise<QueueMutationResult> {
  const queueData = await loadTrainingQueue();

  const index = queueData.queue.findIndex(item => item.operatorId === operatorId);
  if (index === -1) {
    throw new Error('干员不在养成队列中');
  }

  // 获取被删除干员的名称（用于日志）
  const operatorMaterialsData = await loadOperatorMaterials();
  const opData = operatorMaterialsData.operators[operatorId];
  const operatorName = opData?.name || operatorId;

  queueData.queue.splice(index, 1);

  // 重新调整优先级
  queueData.queue.forEach((item, idx) => {
    item.priority = idx + 1;
  });

  logger.info('干员已从养成队列移除', { operatorName, remainingCount: queueData.queue.length });
  return finishQueueMutation(queueData);
}

/**
 * 更新队列顺序
 */
async function updateQueueOrder(orderedOperatorIds: unknown): Promise<QueueMutationResult> {
  const queueData = await loadTrainingQueue();
  const existingIds = queueData.queue.map(item => item.operatorId);
  const orderedIds = Array.isArray(orderedOperatorIds) && orderedOperatorIds.every(id => typeof id === 'string')
    ? orderedOperatorIds as string[]
    : null;
  if (!orderedIds || orderedIds.length !== existingIds.length ||
      new Set(orderedIds).size !== existingIds.length ||
      orderedIds.some(id => !existingIds.includes(id))) {
    throw trainingError('排序必须包含全部养成干员且不能重复');
  }
  const newQueue: TrainingQueueItem[] = [];
  orderedIds.forEach((opId, index) => {
    const item = queueData.queue.find(q => q.operatorId === opId);
    if (item) {
      item.priority = index + 1;
      newQueue.push(item);
    }
  });

  queueData.queue = newQueue;
  return finishQueueMutation(queueData);
}

/**
 * 更新养成设置
 */
async function updateSettings(settings: unknown): Promise<TrainingSettings> {
  const queueData = await loadTrainingQueue();
  queueData.settings = normalizeTrainingSettings({
    ...queueData.settings,
    ...(isRecord(settings) ? settings : {})
  });
  await saveTrainingQueue(queueData);
  return queueData.settings;
}

/**
 * 养成材料数据抓取脚本配置
 * 依赖 scripts/ 中现成的抓取逻辑（保持单一事实来源），按顺序执行：
 * 1. 生成 materials.json（材料表 + 最优关卡）
 * 2. 生成 material-formulas.json（合成配方）
 * 3. 将配方合并进 materials.json
 * 4. 生成 operator-materials.json（干员精英化材料需求）
 * 5. 生成 penguin-drop-data.json（企鹅物流真实掉落统计）
 */
const MATERIAL_FETCH_SCRIPTS: MaterialFetchScriptConfig[] = [
  { name: 'fetch-all-materials', script: 'fetch-all-materials.ts', output: 'materials.json' },
  { name: 'fetch-material-formulas', script: 'fetch-material-formulas.ts', output: 'material-formulas.json' },
  { name: 'merge-formulas', script: 'merge-formulas.ts', output: 'materials.json' },
  { name: 'fetch-operator-materials', script: 'fetch-operator-materials.ts', output: 'operator-materials.json' },
  { name: 'fetch-penguin-stats', script: 'fetch-penguin-stats.ts', output: 'penguin-drop-data.json' }
];

// 单个抓取脚本的超时时间（毫秒）
const FETCH_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 统计数据文件中的条目数（文件缺失或解析失败时返回 null）
 */
async function countDataFileEntries(fileName: string): Promise<number | null> {
  const data = await readJsonFile(path.join(__dirname, '../data', fileName), null);
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (isRecord(record.operators)) return Object.keys(record.operators).length;
  if (isRecord(record.materials)) return Object.keys(record.materials).length;
  return Object.keys(record).length;
}

/**
 * 执行单个数据抓取脚本
 */
async function runMaterialFetchScript(config: MaterialFetchScriptConfig): Promise<MaterialFetchScriptResult> {
  const { name, script, output } = config;
  const scriptPath = path.join(__dirname, '../scripts', script);
  const startedAt = Date.now();
  logger.info('执行材料数据抓取脚本', { name, script });

  try {
    // promisify 在调用时包装，便于测试中通过 mock 替换 execFile
    const { stdout } = await promisify(execFile)(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '..'),
      timeout: FETCH_SCRIPT_TIMEOUT_MS,
      // 脚本输出可能超出默认 1MiB，放宽缓冲避免以晦涩的错误失败
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    const durationMs = Date.now() - startedAt;
    const entries = await countDataFileEntries(output);
    logger.success('材料数据脚本执行成功', { name, durationMs, entries, stdout: stdout?.slice(0, 200) });
    return { name, script, output, success: true, durationMs, entries };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    // execFile 失败时错误对象带有 stderr，优先携带到错误信息中
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr : '';
    const detail = (stderr && stderr.trim()) || errorMessage(error);
    logger.error('材料数据脚本执行失败', { name, durationMs, error: detail });
    return { name, script, output, success: false, durationMs, error: detail };
  }
}

/**
 * 抓取并更新养成材料数据
 * 依次（串行，避免数据源限流）执行 scripts/ 下的抓取脚本，补齐三个数据文件；
 * 单个脚本失败时记录错误并继续跑剩余脚本，最后若有失败则整体抛错
 */
async function fetchOperatorMaterials(): Promise<MaterialFetchSummary> {
  logger.info('开始更新养成材料数据');

  const results: MaterialFetchScriptResult[] = [];
  for (const scriptConfig of MATERIAL_FETCH_SCRIPTS) {
    results.push(await runMaterialFetchScript(scriptConfig));
  }

  const failedScripts = results.filter(result => !result.success);
  if (failedScripts.length > 0) {
    const detail = failedScripts.map(result => `${result.name}: ${result.error}`).join('; ');
    throw new Error(`养成材料数据更新失败（${failedScripts.length}/${results.length} 个脚本失败）: ${detail}`);
  }

  const operatorMaterialsData = await loadOperatorMaterials();
  const materialsDb = await loadMaterialsDatabase();
  const summary: MaterialFetchSummary = {
    scripts: results,
    operatorCount: Object.keys(operatorMaterialsData.operators).length,
    materialCount: Object.keys(materialsDb.materials).length,
    recipeCount: Object.keys(materialsDb.recipes ?? {}).length,
    lastUpdated: new Date().toISOString()
  };

  logger.success('养成材料数据更新完成', {
    operatorCount: summary.operatorCount,
    materialCount: summary.materialCount,
    recipeCount: summary.recipeCount
  });

  return summary;
}

const operatorTrainingService: OperatorTrainingService = {
  getOperatorList,
  getTrainingQueue,
  addToQueue: (...args) => serializeTrainingMutation(() => addToQueue(...args)),
  removeFromQueue: (...args) => serializeTrainingMutation(() => removeFromQueue(...args)),
  updateQueueOrder: (...args) => serializeTrainingMutation(() => updateQueueOrder(...args)),
  updateSettings: (...args) => serializeTrainingMutation(() => updateSettings(...args)),
  syncTrainingFlow: () => serializeTrainingMutation(() => syncTrainingFlow()),
  generateTrainingPlan,
  applyPlanToTasks: (...args) => serializeTrainingMutation(() => applyPlanToTasks(...args)),
  calculateOperatorMaterials,
  fetchOperatorMaterials
};

export default operatorTrainingService;
