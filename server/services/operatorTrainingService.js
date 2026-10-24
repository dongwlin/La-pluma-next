/**
 * 干员养成服务
 * 负责干员识别、材料需求计算、养成队列管理等
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile, writeJsonFile } from '../utils/fileHelper.js';
import { createLogger } from '../utils/logger.js';
import { getTodayOpenStages, isStageOpenToday } from './notificationService.js';
import { getAllOperators } from './dataParserService.js';
import { loadPenguinDropData, findBestFarmStage, getStageEstimate } from './dropDataService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建日志记录器
const logger = createLogger('OperatorTraining');

// 配置文件路径
const TRAINING_QUEUE_PATH = path.join(__dirname, '../data/user-configs/training-queue.json');
const OPERATOR_MATERIALS_PATH = path.join(__dirname, '../data/operator-materials.json');
const OPERBOX_PATH = path.join(__dirname, '../data/operbox.json');
const DEPOT_PATH = path.join(__dirname, '../data/depot.json');

const DEFAULT_TRAINING_SETTINGS = {
  autoSwitch: true,
  notifyOnComplete: true,
  useMedicine: 0,
  useStone: 0
};

// 经验估算兜底值：企鹅掉落数据不可用时沿用旧假设（掉率 50%、每关 18 理智）
const FALLBACK_DROP_RATE = 0.5;
const FALLBACK_SANITY_COST = 18;

function normalizeTrainingSettings(settings = {}) {
  const normalized = { ...settings };
  if (typeof normalized.notify === 'boolean' && typeof normalized.notifyOnComplete !== 'boolean') {
    normalized.notifyOnComplete = normalized.notify;
  }
  delete normalized.notify;
  return {
    ...DEFAULT_TRAINING_SETTINGS,
    ...normalized
  };
}

function getApplicableStages(plan = {}) {
  const candidateStages = Array.isArray(plan.openStages) && plan.openStages.length > 0
    ? plan.openStages
    : Array.isArray(plan.stages)
      ? plan.stages.filter(stage => stage?.isOpen !== false)
      : [];

  return candidateStages.filter(stage => stage?.stage && Number(stage.totalTimes ?? stage.times ?? 0) > 0);
}

/**
 * 关卡代号映射表
 * 将数据库中的关卡代号转换为 MAA 可识别的关卡名称
 */
const STAGE_CODE_MAP = {
  // 芯片关卡
  'pro_a_1': 'PR-A-1', // 医疗/重装芯片
  'pro_a_2': 'PR-A-2', // 医疗/重装芯片组
  'pro_b_1': 'PR-B-1', // 术师/狙击芯片
  'pro_b_2': 'PR-B-2', // 术师/狙击芯片组
  'pro_c_1': 'PR-C-1', // 先锋/辅助芯片
  'pro_c_2': 'PR-C-2', // 先锋/辅助芯片组
  'pro_d_1': 'PR-D-1', // 近卫/特种芯片
  'pro_d_2': 'PR-D-2', // 近卫/特种芯片组
  
  // 技能书关卡
  'ca_1': 'CA-1',
  'ca_2': 'CA-2',
  'ca_3': 'CA-3',
  'ca_4': 'CA-4',
  'ca_5': 'CA-5',
  
  // 龙门币关卡
  'ce_1': 'CE-1',
  'ce_2': 'CE-2',
  'ce_3': 'CE-3',
  'ce_4': 'CE-4',
  'ce_5': 'CE-5',
  'ce_6': 'CE-6',
  
  // 作战记录关卡
  'ls_1': 'LS-1',
  'ls_2': 'LS-2',
  'ls_3': 'LS-3',
  'ls_4': 'LS-4',
  'ls_5': 'LS-5',
  'ls_6': 'LS-6',
  
  // 采购凭证关卡
  'ap_1': 'AP-1',
  'ap_2': 'AP-2',
  'ap_3': 'AP-3',
  'ap_4': 'AP-4',
  'ap_5': 'AP-5',
  
  // 碳关卡
  'sk_1': 'SK-1',
  'sk_2': 'SK-2',
  'sk_3': 'SK-3',
  'sk_4': 'SK-4',
  'sk_5': 'SK-5',
};

/**
 * 芯片类型映射表
 * 根据芯片名称确定应该刷哪个关卡
 */
const CHIP_STAGE_MAP = {
  // 医疗/重装 (PR-A)
  '医疗芯片': 'PR-A-1',
  '医疗芯片组': 'PR-A-2',
  '医疗双芯片': 'PR-A-2',
  '重装芯片': 'PR-A-1',
  '重装芯片组': 'PR-A-2',
  '重装双芯片': 'PR-A-2',
  
  // 术师/狙击 (PR-B)
  '术师芯片': 'PR-B-1',
  '术师芯片组': 'PR-B-2',
  '术师双芯片': 'PR-B-2',
  '狙击芯片': 'PR-B-1',
  '狙击芯片组': 'PR-B-2',
  '狙击双芯片': 'PR-B-2',
  
  // 先锋/辅助 (PR-C)
  '先锋芯片': 'PR-C-1',
  '先锋芯片组': 'PR-C-2',
  '先锋双芯片': 'PR-C-2',
  '辅助芯片': 'PR-C-1',
  '辅助芯片组': 'PR-C-2',
  '辅助双芯片': 'PR-C-2',
  
  // 近卫/特种 (PR-D)
  '近卫芯片': 'PR-D-1',
  '近卫芯片组': 'PR-D-2',
  '近卫双芯片': 'PR-D-2',
  '特种芯片': 'PR-D-1',
  '特种芯片组': 'PR-D-2',
  '特种双芯片': 'PR-D-2',
};

/**
 * 转换关卡代号为 MAA 可识别的格式
 */
function convertStageCode(stageCode) {
  if (!stageCode) return stageCode;
  
  // 如果已经是大写格式，直接返回
  if (stageCode.match(/^[A-Z]{2,3}-[A-Z0-9]-\d+$/)) {
    return stageCode;
  }
  
  // 转换为小写进行匹配
  const lowerCode = stageCode.toLowerCase();
  
  // 查找映射表
  if (STAGE_CODE_MAP[lowerCode]) {
    return STAGE_CODE_MAP[lowerCode];
  }
  
  // 如果没有找到映射，尝试自动转换
  // 例如: pro_a_1 -> PR-A-1
  const match = lowerCode.match(/^([a-z]+)_([a-z])_(\d+)$/);
  if (match) {
    const [, prefix, letter, number] = match;
    return `${prefix.toUpperCase()}-${letter.toUpperCase()}-${number}`;
  }
  
  // 例如: ca_5 -> CA-5
  const match2 = lowerCode.match(/^([a-z]+)_(\d+)$/);
  if (match2) {
    const [, prefix, number] = match2;
    return `${prefix.toUpperCase()}-${number}`;
  }
  
  // 无法转换，返回原值
  logger.warn('无法转换关卡代号', { stageCode });
  return stageCode;
}

/**
 * 加载干员材料数据库
 */
async function loadOperatorMaterials() {
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
async function loadMaterialsDatabase() {
  try {
    const MATERIALS_DB_PATH = path.join(__dirname, '../data/materials.json');
    return await readJsonFile(MATERIALS_DB_PATH, { materials: {}, recipes: {}, stageSchedule: {} });
  } catch (error) {
    logger.error('加载材料数据库失败', { error: error.message });
    return { materials: {}, recipes: {}, stageSchedule: {} };
  }
}

/**
 * 加载材料合成配方数据库
 */
async function loadMaterialFormulas() {
  try {
    const FORMULAS_PATH = path.join(__dirname, '../data/material-formulas.json');
    return await readJsonFile(FORMULAS_PATH, {});
  } catch (error) {
    logger.error('加载材料合成配方失败', { error: error.message });
    return {};
  }
}

/**
 * 加载 OperBox 识别结果
 */
async function loadOperBox() {
  try {
    return await readJsonFile(OPERBOX_PATH, { operators: [] });
  } catch (error) {
    logger.error('加载 OperBox 数据失败', { error: error.message });
    return { operators: [] };
  }
}

function getOperBoxOperators(operBoxData) {
  if (Array.isArray(operBoxData?.data)) return operBoxData.data;
  if (Array.isArray(operBoxData?.operators)) return operBoxData.operators;
  return [];
}

function getTrainingDisabledReason(operator) {
  if (!operator.owned) return 'unowned';
  if (!operator.hasMaterialData) return 'missing_material_data';
  if (operator.currentElite >= operator.targetElite) return 'already_elite2';
  return null;
}

/**
 * 加载仓库数据
 */
async function loadDepot() {
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
 * 加载养成队列
 */
async function loadTrainingQueue() {
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
async function saveTrainingQueue(queueData) {
  try {
    queueData.lastUpdated = new Date().toISOString();
    await writeJsonFile(TRAINING_QUEUE_PATH, queueData);
    return true;
  } catch (error) {
    logger.error('保存养成队列失败', { error: error.message });
    return false;
  }
}

/**
 * 获取干员列表（全量干员为主，OperBox 和材料数据库补充养成状态）
 */
async function getOperatorList(filters = {}) {
  const operatorMaterialsData = await loadOperatorMaterials();
  const operBoxData = await loadOperBox();

  const ownedOperators = getOperBoxOperators(operBoxData);
  const ownedMap = new Map(ownedOperators.map(operator => [operator.id, operator]));
  let allOperators = [];

  try {
    allOperators = await getAllOperators();
  } catch (error) {
    logger.warn('加载全量干员失败，降级为仅显示已识别干员', { error: error.message });
    allOperators = ownedOperators.map(operator => ({
      id: operator.id,
      name: operator.name,
      rarity: operator.rarity,
      profession: operator.profession || '未知'
    }));
  }

  const operators = allOperators.map(baseOperator => {
    const ownedOperator = ownedMap.get(baseOperator.id);
    const opData = operatorMaterialsData.operators?.[baseOperator.id];
    const owned = Boolean(ownedOperator);
    const operator = {
      id: baseOperator.id,
      name: ownedOperator?.name || baseOperator.name,
      rarity: ownedOperator?.rarity ?? baseOperator.rarity,
      profession: opData?.profession || baseOperator.profession || ownedOperator?.profession || '未知',
      position: baseOperator.position,
      currentElite: owned ? (ownedOperator.elite || 0) : 0,
      currentLevel: owned ? (ownedOperator.level || 1) : 0,
      targetElite: 2,
      owned,
      potential: owned ? (ownedOperator.potential || 1) : 0,
      hasMaterialData: !!opData,
      materials: opData ? {
        elite1: opData.elite1,
        elite2: opData.elite2
      } : null
    };

    const disabledReason = getTrainingDisabledReason(operator);
    return {
      ...operator,
      canTrain: disabledReason === null,
      disabledReason,
      trainingStatus: disabledReason === null
        ? 'trainable'
        : owned
          ? disabledReason
          : 'unowned'
    };
  });

  const filteredOperators = operators.filter(operator => {
    if (filters.rarity && operator.rarity !== filters.rarity) return false;
    if (filters.profession && operator.profession !== filters.profession) return false;
    if (filters.owned !== undefined && operator.owned !== filters.owned) return false;
    if (filters.needsElite2 && operator.owned && operator.currentElite >= 2) return false;

    switch (filters.status) {
      case 'trainable':
        return operator.canTrain;
      case 'owned':
        return operator.owned;
      case 'all':
      default:
        return true;
    }
  });

  // 排序：可养成优先，已拥有其次，未拥有最后；同组按稀有度和名称排序
  filteredOperators.sort((a, b) => {
    if (a.canTrain !== b.canTrain) return a.canTrain ? -1 : 1;
    if (a.owned !== b.owned) return a.owned ? -1 : 1;
    if (a.rarity !== b.rarity) return b.rarity - a.rarity;
    if (a.currentElite !== b.currentElite) return a.currentElite - b.currentElite;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return filteredOperators;
}

/**
 * 计算单个干员的材料需求
 */
function calculateOperatorMaterials(operator, depot = {}) {
  const materials = [];
  const totalLMD = { needed: 0, have: 0 };
  const targetElite = operator.targetElite ?? 2;
  
  // 根据当前精英等级决定需要哪些材料
  const needElite1 = operator.currentElite < 1 && targetElite >= 1;
  const needElite2 = operator.currentElite < 2 && targetElite >= 2;
  
  // 收集所有需要的材料
  const allMaterials = {};
  
  if (needElite1 && operator.materials.elite1) {
    totalLMD.needed += operator.materials.elite1.lmd || 0;
    operator.materials.elite1.materials?.forEach(mat => {
      allMaterials[mat.id] = (allMaterials[mat.id] || 0) + mat.count;
    });
  }
  
  if (needElite2 && operator.materials.elite2) {
    totalLMD.needed += operator.materials.elite2.lmd || 0;
    operator.materials.elite2.materials?.forEach(mat => {
      allMaterials[mat.id] = (allMaterials[mat.id] || 0) + mat.count;
    });
    operator.materials.elite2.chips?.forEach(mat => {
      allMaterials[mat.id] = (allMaterials[mat.id] || 0) + mat.count;
    });
  }
  
  // 转换为数组并计算库存
  for (const [id, needed] of Object.entries(allMaterials)) {
    const have = depot[id] || 0;
    const stillNeeded = Math.max(0, needed - have);
    
    // 从材料数据库获取材料名称
    const materialName = getMaterialName(id, operator.materials);
    
    materials.push({
      id,
      name: materialName,
      needed,
      have,
      stillNeeded
    });
  }
  
  // 计算龙门币
  totalLMD.have = depot['4001'] || 0;
  totalLMD.stillNeeded = Math.max(0, totalLMD.needed - totalLMD.have);
  
  return {
    materials,
    lmd: totalLMD,
    isComplete: materials.every(m => m.stillNeeded === 0) && totalLMD.stillNeeded === 0
  };
}

/**
 * 从材料列表中获取材料名称
 */
function getMaterialName(id, operatorMaterials) {
  // 尝试从精1材料中查找
  if (operatorMaterials.elite1?.materials) {
    const mat = operatorMaterials.elite1.materials.find(m => m.id === id);
    if (mat) return mat.name;
  }
  
  // 尝试从精2材料中查找
  if (operatorMaterials.elite2?.materials) {
    const mat = operatorMaterials.elite2.materials.find(m => m.id === id);
    if (mat) return mat.name;
  }
  
  // 尝试从精2芯片中查找
  if (operatorMaterials.elite2?.chips) {
    const mat = operatorMaterials.elite2.chips.find(m => m.id === id);
    if (mat) return mat.name;
  }
  
  return `材料_${id}`;
}

/**
 * 获取养成队列
 */
async function getTrainingQueue() {
  const queueData = await loadTrainingQueue();
  const depot = await loadDepot();
  const operatorMaterialsData = await loadOperatorMaterials();
  
  // 为队列中的每个干员计算材料需求和进度
  const enrichedQueue = [];
  
  for (const queueItem of queueData.queue) {
    const opData = operatorMaterialsData.operators[queueItem.operatorId];
    if (!opData) continue;
    
    const operator = {
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
    
    const materialCalc = calculateOperatorMaterials(operator, depot.items || {});
    
    enrichedQueue.push({
      ...queueItem,
      operator: {
        id: operator.id,
        name: operator.name,
        rarity: operator.rarity,
        profession: operator.profession
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
    lastUpdated: queueData.lastUpdated
  };
}

/**
 * 计算完成进度（百分比）
 */
function calculateProgress(materialCalc) {
  // 计算总需求和总缺少
  const totalNeeded = materialCalc.materials.reduce((sum, m) => sum + m.needed, 0) + 
                      (materialCalc.lmd.needed / 1000); // 龙门币按千计算
  const totalStillNeeded = materialCalc.materials.reduce((sum, m) => sum + m.stillNeeded, 0) + 
                           (materialCalc.lmd.stillNeeded / 1000);
  
  if (totalNeeded === 0) return 100;
  
  // 进度 = (总需求 - 还需要的) / 总需求 * 100
  const progress = ((totalNeeded - totalStillNeeded) / totalNeeded) * 100;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

/**
 * 添加干员到养成队列
 */
async function addToQueue(operatorId, options = {}) {
  const queueData = await loadTrainingQueue();
  const operatorMaterialsData = await loadOperatorMaterials();
  const operBoxData = await loadOperBox();
  
  const opData = operatorMaterialsData.operators[operatorId];
  if (!opData) {
    throw new Error(`干员材料数据不存在，暂不支持该干员`);
  }
  
  // 从 OperBox 获取干员名称
  const operBoxOp = operBoxData.data?.find(op => op.id === operatorId);
  const operatorName = operBoxOp?.name || opData.name;
  
  // 检查是否已在队列中
  const existingIndex = queueData.queue.findIndex(item => item.operatorId === operatorId);
  if (existingIndex !== -1) {
    throw new Error(`干员 ${operatorName} 已在养成队列中`);
  }
  
  // 添加到队列
  const queueItem = {
    operatorId,
    currentElite: options.currentElite ?? operBoxOp?.elite ?? 0,
    targetElite: options.targetElite ?? 2,
    priority: queueData.queue.length + 1,
    status: 'pending',
    addedAt: new Date().toISOString()
  };
  
  queueData.queue.push(queueItem);
  await saveTrainingQueue(queueData);
  
  return queueItem;
}

/**
 * 从养成队列中移除干员
 */
async function removeFromQueue(operatorId) {
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
  
  await saveTrainingQueue(queueData);
  
  logger.info('干员已从养成队列移除', { operatorName, remainingCount: queueData.queue.length });
  
  // 重新生成刷取计划并应用到任务流程
  try {
    if (queueData.queue.length > 0) {
      // 还有其他干员，重新生成计划
      logger.info('重新生成刷取计划', { remainingOperators: queueData.queue.length });
      const plan = await generateTrainingPlan('current');
      await applyPlanToTasks(plan, queueData.settings || {});
      logger.success('刷取计划已更新');
    } else {
      // 队列为空，清除所有智能养成关卡
      logger.info('养成队列已空，清除所有智能养成关卡');
      await clearSmartTrainingStages();
    }
  } catch (error) {
    logger.error('更新刷取计划失败', { error: error.message });
    // 即使更新失败也不影响删除操作
  }
  
  return true;
}

/**
 * 清除所有智能养成关卡
 */
async function clearSmartTrainingStages() {
  const COMBAT_TASKS_PATH = path.join(__dirname, '../data/user-configs/automation-tasks.json');
  
  try {
    // 读取现有配置
    const config = await readJsonFile(COMBAT_TASKS_PATH, { taskFlow: [], schedule: { enabled: false, times: [] } });
    
    // 查找 fight 任务
    const fightTask = config.taskFlow?.find(t => t.commandId === 'fight');
    
    if (fightTask && fightTask.params.stages) {
      // 过滤掉所有智能养成关卡
      const existingStages = fightTask.params.stages || [];
      const nonSmartStages = existingStages.filter(s => !s.smart);
      
      logger.info('清除智能关卡', { 
        originalCount: existingStages.length, 
        remainingCount: nonSmartStages.length 
      });
      
      fightTask.params.stages = nonSmartStages;
      
      // 保存配置
      await writeJsonFile(COMBAT_TASKS_PATH, config);
      logger.success('智能关卡已清除');
    }
  } catch (error) {
    logger.error('清除智能关卡失败', { error: error.message });
    throw error;
  }
}

/**
 * 更新队列顺序
 */
async function updateQueueOrder(orderedOperatorIds) {
  const queueData = await loadTrainingQueue();
  
  const newQueue = [];
  orderedOperatorIds.forEach((opId, index) => {
    const item = queueData.queue.find(q => q.operatorId === opId);
    if (item) {
      item.priority = index + 1;
      newQueue.push(item);
    }
  });
  
  queueData.queue = newQueue;
  await saveTrainingQueue(queueData);
  
  return true;
}

/**
 * 更新养成设置
 */
async function updateSettings(settings) {
  const queueData = await loadTrainingQueue();
  queueData.settings = normalizeTrainingSettings({ ...queueData.settings, ...settings });
  await saveTrainingQueue(queueData);
  return queueData.settings;
}

/**
 * 展开单个材料支路，返回该支路的可刷取材料
 * @param {string} materialId - 材料ID
 * @param {number} needed - 需要数量
 * @param {object} depot - 仓库数据
 * @param {object} materialsDb - 材料数据库
 * @param {object} formulasDb - 合成配方数据库
 * @param {Set<string>} visiting - 当前递归路径上的材料ID，用于识别配方循环引用
 * @returns {{ blocked: boolean, blockedMaterialName: string|null, farmable: object }}
 *   blocked 为 true 表示该支路的配方展开被循环引用阻断（farmable 为空），
 *   由上层放弃整条配方转换链并回退为「根材料本身直接刷取」
 */
function expandMaterialBranch(materialId, needed, depot, materialsDb, formulasDb, visiting) {
  const material = materialsDb.materials[materialId];
  if (!material) {
    logger.debug('材料不存在', { materialId });
    return { blocked: false, blockedMaterialName: null, farmable: {} };
  }

  // 检查仓库中的数量
  const have = depot.items?.[materialId] || 0;
  const stillNeeded = Math.max(0, needed - have);

  if (stillNeeded === 0) {
    logger.debug('材料仓库已足够', { materialName: material.name });
    return { blocked: false, blockedMaterialName: null, farmable: {} };
  }

  // 环命中：不做任何产出，向上层报告阻断位置，由展开根回退为直接刷取
  if (visiting.has(materialId)) {
    logger.debug('材料配方存在循环引用，阻断该支路', { materialName: material.name });
    return { blocked: true, blockedMaterialName: material.name, farmable: {} };
  }

  // 芯片特殊处理：芯片组不展开，直接刷取；双芯片需要展开合成
  if (material.name.includes('芯片组')) { // 芯片组（如辅助芯片组）
    // 芯片组直接刷芯片组关卡（PR-X-2），不展开合成
    logger.debug('芯片组直接刷取', { materialName: material.name });
    return { blocked: false, blockedMaterialName: null, farmable: { [materialId]: stillNeeded } };
  }

  // 双芯片需要展开合成配方（通常需要 2×芯片组 + 1×芯片助剂）
  // 这样可以正确扣除仓库中已有的芯片组

  // 检查是否有合成配方（配方直接在根对象下，不是在 formulas 属性下）
  const formula = formulasDb[materialId];

  if (formula && formula.materials && Object.keys(formula.materials).length > 0) {
    // 有合成配方，递归展开子材料
    logger.debug('材料需要合成，展开子材料', { materialName: material.name });

    const branchVisiting = new Set(visiting).add(materialId);
    const branchFarmable = {};
    let blockedMaterialName = null;

    for (const [subMaterialId, subQuantity] of Object.entries(formula.materials)) {
      const totalSubNeeded = subQuantity * stillNeeded;
      logger.debug('展开子材料', {
        subMaterialId,
        subQuantity,
        totalSubNeeded
      });
      const subResult = expandMaterialBranch(subMaterialId, totalSubNeeded, depot, materialsDb, formulasDb, branchVisiting);

      if (subResult.blocked) {
        // 子支路被环阻断：放弃本材料的整条配方转换链，已收集的正常子材料一并作废——
        // 它们的产出只为合成根材料，改为直接刷取后不再需要；继续向上层报告，最终由展开根回退
        blockedMaterialName = subResult.blockedMaterialName;
        break;
      }

      for (const [id, count] of Object.entries(subResult.farmable)) {
        branchFarmable[id] = (branchFarmable[id] || 0) + count;
      }
    }

    if (blockedMaterialName) {
      return { blocked: true, blockedMaterialName, farmable: {} };
    }

    return { blocked: false, blockedMaterialName: null, farmable: branchFarmable };
  }

  // 没有合成配方，这是可以直接刷的材料
  logger.debug('可刷取材料', { materialName: material.name });
  return { blocked: false, blockedMaterialName: null, farmable: { [materialId]: stillNeeded } };
}

/**
 * 递归展开材料树，找到所有需要刷的原材料
 * 配方数据存在循环引用时（如芯片互转配方：狙击芯片 ↔ 术师芯片），
 * 被阻断的转换链会整体作废，回退为「展开根材料本身直接刷取」，
 * 由关卡映射（如 CHIP_STAGE_MAP）决定刷取关卡；仓库已覆盖的正常空结果不受影响
 * @param {string} materialId - 材料ID
 * @param {number} needed - 需要数量
 * @param {object} depot - 仓库数据
 * @param {object} materialsDb - 材料数据库
 * @param {object} formulasDb - 合成配方数据库
 * @param {object} farmableMaterials - 累积的可刷取材料 {materialId: quantity}
 */
export function expandMaterialTree(materialId, needed, depot, materialsDb, formulasDb, farmableMaterials = {}) {
  const result = expandMaterialBranch(materialId, needed, depot, materialsDb, formulasDb, new Set());

  if (result.blocked) {
    // 配方展开遇环，回退为该材料本身直接刷取，避免整条支路被静默丢弃
    logger.warn('材料配方展开遇环，回退为直接刷取', {
      materialName: materialsDb.materials[materialId]?.name || materialId,
      cycleMaterialName: result.blockedMaterialName
    });
    const stillNeeded = Math.max(0, needed - (depot.items?.[materialId] || 0));
    if (stillNeeded > 0) {
      farmableMaterials[materialId] = (farmableMaterials[materialId] || 0) + stillNeeded;
    }
    return farmableMaterials;
  }

  for (const [id, count] of Object.entries(result.farmable)) {
    farmableMaterials[id] = (farmableMaterials[id] || 0) + count;
  }

  return farmableMaterials;
}

/**
 * 将掉落数据服务的关卡查询结果转换为刷取估算结果
 */
function toEstimate(found) {
  return {
    stage: found.code,
    stageId: found.stageId,
    apCost: found.apCost,
    expectedPerRun: found.expectedPerRun,
    samples: found.samples,
    dataSource: 'penguin-stats',
    fallbackReason: null
  };
}

/**
 * 为单个材料选择刷取关卡并给出期望掉落与理智单价
 *
 * 数据来源：企鹅物流公开 API v2（server=CN），由 scripts/fetch-penguin-stats.js
 * 抓取为 server/data/penguin-drop-data.json，数据版本见文件 metadata.fetchedAt：
 * - 芯片类材料刷取关卡固定（CHIP_STAGE_MAP），期望掉落取该关卡的真实统计；
 * - 其余材料在企鹅矩阵中按「期望理智消耗/个」（apCost / 期望掉落）反查最优永久关卡；
 * - 掉落数据缺失、该材料无样本或无候选关卡时，回退经验估算：
 *   掉率 50%、每关 18 理智（沿用 2026-10 之前的假设，误差大，仅保证计划不中断）。
 *
 * @returns {{ stage, stageId, apCost, expectedPerRun, samples, dataSource, fallbackReason }|null}
 *   null 表示无任何可用关卡，调用方应 warn 并跳过该材料
 */
export function estimateMaterialFarming(material, dropData) {
  const isChip = Boolean(CHIP_STAGE_MAP[material.name]);

  if (isChip) {
    const stageCode = CHIP_STAGE_MAP[material.name];
    const found = getStageEstimate(stageCode, material.id, dropData);
    if (found) {
      return toEstimate(found);
    }
    return {
      stage: stageCode,
      stageId: null,
      apCost: FALLBACK_SANITY_COST,
      expectedPerRun: FALLBACK_DROP_RATE,
      samples: null,
      dataSource: 'experience',
      fallbackReason: dropData ? '掉落数据中无该关卡统计' : '掉落数据未加载'
    };
  }

  const found = findBestFarmStage(material.id, dropData);
  if (found) {
    return toEstimate(found);
  }

  // 回退：材料库的最优关卡（来自游戏数据 stageDropList，可能指向已过期活动关）
  const rawStage = material.bestStage || (material.bestStages && material.bestStages[0]?.stage);
  if (!rawStage) return null;

  return {
    stage: convertStageCode(rawStage),
    stageId: rawStage,
    apCost: FALLBACK_SANITY_COST,
    expectedPerRun: FALLBACK_DROP_RATE,
    samples: null,
    dataSource: 'experience',
    fallbackReason: dropData ? '掉落数据中无该材料的可刷关卡' : '掉落数据未加载'
  };
}

/**
 * 生成养成计划（刷取计划）
 */
async function generateTrainingPlan(mode = 'current') {
  const queueData = await loadTrainingQueue();
  const depot = await loadDepot();
  const operatorMaterialsData = await loadOperatorMaterials();
  const materialsDb = await loadMaterialsDatabase();
  
  if (queueData.queue.length === 0) {
    throw new Error('养成队列为空');
  }
  
  // 收集需要刷取的材料
  const materialNeeds = {};
  const operators = [];
  
  // 根据模式决定处理哪些干员
  const operatorsToProcess = mode === 'current' 
    ? [queueData.queue[0]] 
    : queueData.queue;
  
  for (const queueItem of operatorsToProcess) {
    const opData = operatorMaterialsData.operators[queueItem.operatorId];
    if (!opData) continue;
    
    const operator = {
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
    
    const materialCalc = calculateOperatorMaterials(operator, depot.items || {});
    
    // 只添加还需要材料的干员
    if (!materialCalc.isComplete) {
      operators.push({
        id: operator.id,
        name: operator.name,
        rarity: operator.rarity,
        currentElite: operator.currentElite,
        targetElite: operator.targetElite,
        materials: materialCalc.materials.filter(m => m.stillNeeded > 0)
      });
      
      // 汇总材料需求
      materialCalc.materials.forEach(mat => {
        if (mat.stillNeeded > 0) {
          materialNeeds[mat.id] = (materialNeeds[mat.id] || 0) + mat.stillNeeded;
        }
      });
    }
  }
  
  if (Object.keys(materialNeeds).length === 0) {
    return {
      operators,
      materials: [],
      materialHierarchy: [],
      stages: [],
      totalSanity: 0,
      warnings: ['所有干员的材料已集齐！']
    };
  }
  
  logger.info('开始展开材料树', { materialCount: Object.keys(materialNeeds).length });
  logger.debug('原始材料需求', { materialNeeds });
  
  // 加载合成配方数据库
  const formulasDb = await loadMaterialFormulas();
  
  // 递归展开所有材料，找到需要刷的原材料
  const farmableMaterials = {};
  for (const [materialId, needed] of Object.entries(materialNeeds)) {
    expandMaterialTree(materialId, needed, depot, materialsDb, formulasDb, farmableMaterials);
  }
  
  logger.info('材料树展开完成', { farmableMaterialCount: Object.keys(farmableMaterials).length });
  logger.debug('可刷取材料', { farmableMaterials });

  // 企鹅物流真实掉落数据：缺失时 estimateMaterialFarming 会自动回退经验估算
  const dropData = await loadPenguinDropData();
  if (dropData?.metadata) {
    logger.info('掉落数据已加载', {
      server: dropData.metadata.server,
      fetchedAt: dropData.metadata.fetchedAt
    });
  }

  // 生成刷取计划
  const materialHierarchy = [];
  const stagesMap = new Map();
  const warnings = [];
  const fallbackMaterials = [];

  // 为每个可刷取的材料生成关卡
  for (const [materialId, needed] of Object.entries(farmableMaterials)) {
    const material = materialsDb.materials[materialId];
    if (!material) {
      warnings.push(`材料 ${materialId} 在数据库中不存在`);
      continue;
    }

    logger.debug('处理材料', { materialName: material.name, needed });

    materialHierarchy.push({
      id: materialId,
      name: material.name,
      iconId: material.iconId,
      needed,
      have: depot.items?.[materialId] || 0,
      stillNeeded: needed,
      children: []
    });

    if (needed > 0) {
      const estimate = estimateMaterialFarming(material, dropData);
      if (!estimate) {
        warnings.push(`材料 ${material.name} 没有最优关卡信息`);
        logger.warn('材料没有最优关卡', { materialName: material.name });
        continue;
      }

      if (estimate.fallbackReason) {
        fallbackMaterials.push(material.name);
        logger.warn('材料回退经验估算', { materialName: material.name, reason: estimate.fallbackReason });
      }

      if (!stagesMap.has(estimate.stage)) {
        stagesMap.set(estimate.stage, {
          stage: estimate.stage,
          stageId: estimate.stageId,
          apCost: estimate.apCost,
          dataSource: estimate.dataSource,
          materials: [],
          // 该关卡需要产出的期望掉落总数（各材料 stillNeeded / 期望掉落 之和），最终向上取整为刷取次数
          expectedDrops: 0,
          isOpen: true // 简化版本假设都开放
        });
      }

      const stageData = stagesMap.get(estimate.stage);
      stageData.materials.push({
        id: materialId,
        name: material.name,
        count: needed
      });
      stageData.expectedDrops += needed / estimate.expectedPerRun;
    }
  }

  if (fallbackMaterials.length > 0) {
    warnings.push(
      `企鹅物流掉落数据不可用，${fallbackMaterials.length} 种材料按经验估算（掉率 ${FALLBACK_DROP_RATE * 100}%、每关 ${FALLBACK_SANITY_COST} 理智）：${fallbackMaterials.join('、')}`
    );
  }

  // 刷取次数 = 该关累计期望掉落向上取整；理智 = 次数 × 关卡真实理智消耗（企鹅物流 apCost）
  const stages = Array.from(stagesMap.values()).map(stageData => {
    const totalTimes = Math.ceil(stageData.expectedDrops);
    return {
      stage: stageData.stage,
      stageId: stageData.stageId,
      apCost: stageData.apCost,
      dataSource: stageData.dataSource,
      materials: stageData.materials,
      totalTimes,
      sanity: totalTimes * stageData.apCost,
      // isStageOpenToday 返回 { isOpen, reason } 对象，这里取布尔值供客户端判断
      isOpen: isStageOpenToday(stageData.stage).isOpen
    };
  });
  const totalSanity = stages.reduce((sum, stage) => sum + stage.sanity, 0);
  const todayOpen = getTodayOpenStages();
  const openStages = stages.filter(stage => stage.isOpen !== false);
  const closedStages = stages.filter(stage => stage.isOpen === false);
  const focusOperator = operators[0] || null;
  
  return {
    operators,
    materialHierarchy,
    stages,
    openStages,
    closedStages,
    focusOperator,
    totalSanity,
    estimatedTime: Math.ceil(totalSanity / 240 * 60), // 假设每天240理智，转换为分钟
    warnings,
    mode,
    // 估算所用的企鹅物流掉落数据版本；null 表示本次生成全部回退经验估算
    dropDataInfo: dropData?.metadata || null,
    summary: {
      backlogCount: Math.max(operators.length - 1, 0),
      openStageCount: openStages.length,
      closedStageCount: closedStages.length,
      todayOpenResourceStages: todayOpen.open,
      todayClosedResourceStages: todayOpen.closed
    }
  };
}

/**
 * 应用养成计划到任务流程
 */
async function applyPlanToTasks(plan, settings = {}) {
  const queueData = await loadTrainingQueue();
  const effectiveSettings = normalizeTrainingSettings({ ...queueData.settings, ...settings });
  const applicableStages = getApplicableStages(plan);

  logger.info('开始应用养成计划');
  logger.debug('计划详情', { 
    stageCount: plan.stages?.length || 0,
    applicableStageCount: applicableStages.length,
    operatorCount: plan.operators?.length || 0
  });
  
  // 保存到作战任务配置
  const COMBAT_TASKS_PATH = path.join(__dirname, '../data/user-configs/automation-tasks.json');
  
  try {
    // 读取现有配置
    const config = await readJsonFile(COMBAT_TASKS_PATH, { 
      taskFlow: [], 
      schedule: { enabled: false, times: [] } 
    });
    
    logger.debug('成功读取现有配置', { taskCount: config.taskFlow?.length || 0 });
    
    // 查找或创建 fight 任务
    let fightTask = config.taskFlow.find(t => t.commandId === 'fight');
    
    if (!fightTask) {
      fightTask = {
        id: `fight-${Date.now()}`,
        name: '理智作战',
        description: '自动刷关卡消耗理智',
        commandId: 'fight',
        enabled: true,
        params: {
          stage: '1-7',
          stages: [],
          medicine: effectiveSettings.useMedicine || 0,
          expiringMedicine: 0,
          stone: effectiveSettings.useStone || 0,
          series: 0
        }
      };
      config.taskFlow.push(fightTask);
      logger.info('创建了新的 fight 任务');
    }
    
    // 获取现有的 stages，并分类
    const existingStages = fightTask.params.stages || [];
    const pinnedStages = existingStages.filter(s => s.pinned);
    const normalStages = existingStages.filter(s => !s.pinned && !s.smart);
    
    logger.debug('现有关卡分类', { 
      total: existingStages.length,
      pinned: pinnedStages.length,
      normal: normalStages.length
    });
    
    // 构建新的智能养成关卡
    const smartStages = [];
    
    // 获取正在养成的干员名称
    let trainingOperatorNames = [];
    if (plan.operators && plan.operators.length > 0) {
      trainingOperatorNames = plan.operators.map(op => op.name);
    }
    
    logger.debug('养成干员', { operators: trainingOperatorNames });
    
    if (applicableStages.length > 0) {
      applicableStages.forEach(stage => {
        smartStages.push({
          stage: stage.stage,
          times: String(stage.totalTimes ?? stage.times ?? 0),
          smart: true,
          trainingOperators: trainingOperatorNames
        });
      });
      logger.info('生成智能关卡', { count: smartStages.length });
    }
    
    // 添加 fallback 关卡（理智用完后刷什么）
    if (effectiveSettings.fallbackStage && effectiveSettings.fallbackStage.trim()) {
      smartStages.push({
        stage: effectiveSettings.fallbackStage.trim(),
        times: (effectiveSettings.fallbackTimes || 999).toString(),
        smart: true,
        trainingOperators: trainingOperatorNames
      });
      logger.debug('添加 fallback 关卡', { stage: effectiveSettings.fallbackStage });
    }
    
    // 重新组合关卡顺序：置顶 -> 智能 -> 普通
    const newStages = [...pinnedStages, ...smartStages, ...normalStages];
    
    logger.info('关卡重组完成', { 
      totalStages: newStages.length,
      smartStages: smartStages.length
    });
    
    // 更新任务参数
    fightTask.params = {
      ...fightTask.params,
      stages: newStages,
      medicine: effectiveSettings.useMedicine || 0,
      expiringMedicine: 0,
      stone: effectiveSettings.useStone || 0,
      series: fightTask.params.series || 0
    };
    
    // 保存配置
    await writeJsonFile(COMBAT_TASKS_PATH, config);
    logger.success('养成计划应用成功');
    
    return { 
      success: true, 
      stageCount: smartStages.length,
      totalStages: newStages.length,
      hasFallback: !!effectiveSettings.fallbackStage
    };
  } catch (error) {
    logger.error('应用任务流程失败', { error: error.message });
    throw new Error('应用任务流程失败');
  }
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
const MATERIAL_FETCH_SCRIPTS = [
  { name: 'fetch-all-materials', script: 'fetch-all-materials.js', output: 'materials.json' },
  { name: 'fetch-material-formulas', script: 'fetch-material-formulas.js', output: 'material-formulas.json' },
  { name: 'merge-formulas', script: 'merge-formulas.js', output: 'materials.json' },
  { name: 'fetch-operator-materials', script: 'fetch-operator-materials.js', output: 'operator-materials.json' },
  { name: 'fetch-penguin-stats', script: 'fetch-penguin-stats.js', output: 'penguin-drop-data.json' }
];

// 单个抓取脚本的超时时间（毫秒）
const FETCH_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 统计数据文件中的条目数（文件缺失或解析失败时返回 null）
 */
async function countDataFileEntries(fileName) {
  const data = await readJsonFile(path.join(__dirname, '../data', fileName), null);
  if (!data || typeof data !== 'object') return null;
  if (data.operators) return Object.keys(data.operators).length;
  if (data.materials) return Object.keys(data.materials).length;
  return Object.keys(data).length;
}

/**
 * 执行单个数据抓取脚本
 */
async function runMaterialFetchScript({ name, script, output }) {
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
    const detail = (error.stderr && String(error.stderr).trim()) || error.message;
    logger.error('材料数据脚本执行失败', { name, durationMs, error: detail });
    return { name, script, output, success: false, durationMs, error: detail };
  }
}

/**
 * 抓取并更新养成材料数据
 * 依次（串行，避免数据源限流）执行 scripts/ 下的抓取脚本，补齐三个数据文件；
 * 单个脚本失败时记录错误并继续跑剩余脚本，最后若有失败则整体抛错
 */
async function fetchOperatorMaterials() {
  logger.info('开始更新养成材料数据');

  const results = [];
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
  const summary = {
    scripts: results,
    operatorCount: Object.keys(operatorMaterialsData.operators || {}).length,
    materialCount: Object.keys(materialsDb.materials || {}).length,
    recipeCount: Object.keys(materialsDb.recipes || {}).length,
    lastUpdated: new Date().toISOString()
  };

  logger.success('养成材料数据更新完成', {
    operatorCount: summary.operatorCount,
    materialCount: summary.materialCount,
    recipeCount: summary.recipeCount
  });

  return summary;
}

export default {
  getOperatorList,
  getTrainingQueue,
  addToQueue,
  removeFromQueue,
  updateQueueOrder,
  updateSettings,
  generateTrainingPlan,
  applyPlanToTasks,
  calculateOperatorMaterials,
  fetchOperatorMaterials
};
