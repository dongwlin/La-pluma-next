/**
 * 养成领域纯模型
 *
 * 训练设置默认值与归一化、候选干员的可用性判定、单干员材料需求与完成进度、
 * 计划关卡投影和领域错误工厂。这里只做数据投影与计算，不读取文件、
 * 不写队列、不触发流程或定时同步；持久化在 operatorTrainingStore，
 * 刷取计划在 operatorTrainingPlan，配置与调度副作用在 operatorTrainingApplication。
 */

export const DEFAULT_TRAINING_SETTINGS = {
  autoSwitch: true,
  notifyOnComplete: true,
  useMedicine: 0,
  useStone: 0
};

export function trainingError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeTrainingSettings(settings = {}) {
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

/** 从计划中挑选可执行的关卡：优先 openStages，否则取标记开放的 stages。 */
export function getApplicableStages(plan = {}) {
  const candidateStages = Array.isArray(plan.openStages) && plan.openStages.length > 0
    ? plan.openStages
    : Array.isArray(plan.stages)
      ? plan.stages.filter(stage => stage?.isOpen !== false)
      : [];

  return candidateStages.filter(stage => stage?.stage && Number(stage.totalTimes ?? stage.times ?? 0) > 0);
}

export function getTrainingDisabledReason(operator) {
  if (!operator.owned) return 'unowned';
  if (!operator.hasMaterialData) return 'missing_material_data';
  if (operator.currentElite >= operator.targetElite) return 'already_elite2';
  return null;
}

/** OperBox 旧结构兼容：`data` 与 `operators` 都表示已识别干员数组。 */
export function getOperBoxOperators(operBoxData) {
  if (Array.isArray(operBoxData?.data)) return operBoxData.data;
  if (Array.isArray(operBoxData?.operators)) return operBoxData.operators;
  return [];
}

/**
 * 候选干员投影与计数：全量干员为基底，OperBox 与材料数据补充持有/养成状态，
 * 再按过滤条件筛选并排序。纯函数，不读取目录、OperBox 或材料文件；
 * 读取失败时的降级由调用方决定传入哪份 baseOperators。
 */
export function buildTrainingCandidates(baseOperators, ownedOperators, operatorMaterialsData, filters = {}) {
  const ownedMap = new Map(ownedOperators.map(operator => [operator.id, operator]));

  const operators = baseOperators.map(baseOperator => {
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
export function calculateOperatorMaterials(operator, depot = {}) {
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
export function getMaterialName(id, operatorMaterials) {
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
 * 计算完成进度（百分比）
 */
export function calculateProgress(materialCalc) {
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
