/**
 * 养成领域持久化
 *
 * 训练队列的读取、写入、写入串行化与 queueRevision，以及养成所需的游戏数据快照
 * （干员材料、材料库、合成配方、OperBox、仓库）和自动化任务配置的读写。
 *
 * 这里是该领域文件访问的唯一入口：领域命令与应用同步通过本模块读写，不自行拼路径。
 * 材料需求与设置归一化等纯计算在 operatorTrainingModel。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonFile, updateJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { DEFAULT_TRAINING_SETTINGS, normalizeTrainingSettings } from './operatorTrainingModel.js';

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

// Keep read-modify-write operations together, including the flow synchronization.
let trainingMutation = Promise.resolve();
export function serializeTrainingMutation(operation) {
  const current = trainingMutation.catch(() => undefined).then(operation);
  trainingMutation = current;
  return current;
}

export function getQueueRevision(queueData) {
  return createHash('sha256').update(JSON.stringify(queueData.queue.map(item => ({
    operatorId: item.operatorId,
    currentElite: item.currentElite ?? 0,
    targetElite: item.targetElite ?? 2
  })))).digest('hex');
}

/**
 * 加载养成队列（默认设置与旧结构归一化在读取时完成）
 */
export async function loadTrainingQueue() {
  const defaultQueue = {
    queue: [],
    settings: DEFAULT_TRAINING_SETTINGS,
    lastUpdated: new Date().toISOString()
  };

  const queueData = await readJsonFile(TRAINING_QUEUE_PATH, defaultQueue);
  return {
    ...defaultQueue,
    ...queueData,
    settings: normalizeTrainingSettings(queueData.settings)
  };
}

/**
 * 保存养成队列
 */
export async function saveTrainingQueue(queueData) {
  try {
    queueData.lastUpdated = new Date().toISOString();
    await writeJsonFile(TRAINING_QUEUE_PATH, queueData);
    return true;
  } catch (error) {
    logger.error('保存养成队列失败', { error: error.message });
    throw error;
  }
}

/**
 * 加载干员材料数据库
 */
export async function loadOperatorMaterials() {
  try {
    return await readJsonFile(OPERATOR_MATERIALS_PATH, { operators: {}, metadata: {} });
  } catch (error) {
    logger.error('加载干员材料数据失败', { error: error.message });
    return { operators: {}, metadata: {} };
  }
}

/**
 * 加载材料数据库（包含 recipes）
 */
export async function loadMaterialsDatabase() {
  try {
    const MATERIALS_DB_PATH = path.join(DATA_DIRECTORY, 'materials.json');
    return await readJsonFile(MATERIALS_DB_PATH, { materials: {}, recipes: {}, stageSchedule: {} });
  } catch (error) {
    logger.error('加载材料数据库失败', { error: error.message });
    return { materials: {}, recipes: {}, stageSchedule: {} };
  }
}

/**
 * 加载材料合成配方数据库
 */
export async function loadMaterialFormulas() {
  try {
    const FORMULAS_PATH = path.join(DATA_DIRECTORY, 'material-formulas.json');
    return await readJsonFile(FORMULAS_PATH, {});
  } catch (error) {
    logger.error('加载材料合成配方失败', { error: error.message });
    return {};
  }
}

/**
 * 加载 OperBox 识别结果
 */
export async function loadOperBox() {
  try {
    return await readJsonFile(OPERBOX_PATH, { operators: [] });
  } catch (error) {
    logger.error('加载 OperBox 数据失败', { error: error.message });
    return { operators: [] };
  }
}

/**
 * 加载仓库数据
 */
export async function loadDepot() {
  try {
    const depotData = await readJsonFile(DEPOT_PATH, { items: [], timestamp: null });

    // 将数组转换为对象 { id: count }
    const itemsMap = {};
    if (depotData.items && Array.isArray(depotData.items)) {
      depotData.items.forEach(item => {
        itemsMap[item.id] = item.count;
      });
    }

    return { items: itemsMap, timestamp: depotData.timestamp };
  } catch (error) {
    logger.error('加载仓库数据失败', { error: error.message });
    return { items: {}, timestamp: null };
  }
}

/**
 * 读取自动化任务配置；缺失或损坏时使用调用方给出的默认结构。
 */
export async function readCombatTasksConfig(defaultValue = { taskFlow: [] }) {
  return readJsonFile(COMBAT_TASKS_PATH, defaultValue);
}

/**
 * 串行读改写自动化任务配置。写入与其它同文件写入共用 fileHelper 的路径级队列。
 */
export async function updateCombatTasksConfig(updateFn, defaultValue) {
  return updateJsonFile(COMBAT_TASKS_PATH, updateFn, defaultValue);
}
