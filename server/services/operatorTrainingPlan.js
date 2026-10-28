/**
 * 养成计算与刷取计划
 *
 * 材料配方展开、掉落估算、关卡代号转换和计划生成。计划只由队列、仓库、
 * 材料库与掉落数据算出，不写队列、不改自动化任务、不注册定时任务；
 * 数据读取经 operatorTrainingStore，应用计划在 operatorTrainingApplication。
 */

import { createLogger } from '../utils/logger.ts';
import { getTodayOpenStages, isStageOpenToday } from './notificationService.ts';
import { findBestFarmStage, getStageEstimate, loadPenguinDropData } from './dropDataService.ts';
import { calculateOperatorMaterials, trainingError } from './operatorTrainingModel.js';
import {
  getQueueRevision,
  loadDepot,
  loadMaterialFormulas,
  loadMaterialsDatabase,
  loadOperatorMaterials,
  loadTrainingQueue
} from './operatorTrainingStore.js';

// 创建日志记录器（与养成领域其它模块共用同一命名 logger）
const logger = createLogger('OperatorTraining');

// 经验估算兜底值：企鹅掉落数据不可用时沿用旧假设（掉率 50%、每关 18 理智）
const FALLBACK_DROP_RATE = 0.5;
const FALLBACK_SANITY_COST = 18;

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
export async function generateTrainingPlan(mode = 'current') {
  if (!['current', 'all'].includes(mode)) throw trainingError('计划模式必须为 current 或 all');
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
  let totalLmdNeeded = 0;

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
    totalLmdNeeded += materialCalc.lmd.needed;

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

  const missingLmd = Math.max(0, totalLmdNeeded - (depot.items?.['4001'] || 0));
  const warnings = missingLmd > 0
    ? [`尚缺 ${missingLmd} 龙门币；当前计划不包含龙门币刷取估算，请另行安排。`]
    : [];

  if (Object.keys(materialNeeds).length === 0) {
    return {
      queueRevision: getQueueRevision(queueData),
      mode,
      operators,
      materials: [],
      materialHierarchy: [],
      stages: [],
      totalSanity: 0,
      warnings: warnings.length > 0 ? warnings : ['所有干员的材料已集齐！']
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
      sanityPerRun: stageData.apCost,
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
    queueRevision: getQueueRevision(queueData),
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
