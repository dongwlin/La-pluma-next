import { loadUserConfig, saveUserConfig } from './configStorageService.ts';
import operatorTrainingService from './operatorTrainingService.js';
import { createLogger } from '../utils/logger.ts';

// 流程结束后的智能养成关卡回写：读取养成队列、生成刷取计划并保存任务流程。
// 这是流程执行之外的存储适配，执行模块只通过端口请求刷新，不直接读写配置。

const logger = createLogger('Scheduler');

export function getPlanOpenStages(plan = {}) {
  const stages = Array.isArray(plan.openStages) && plan.openStages.length > 0
    ? plan.openStages
    : Array.isArray(plan.stages)
      ? plan.stages.filter(stage => stage?.isOpen !== false)
      : [];

  return stages.filter(stage => stage?.stage && Number(stage.totalTimes ?? stage.times ?? 0) > 0);
}

export function buildSmartTrainingStages(plan = {}) {
  const trainingOperatorNames = Array.isArray(plan.operators)
    ? plan.operators.map(op => op.name).filter(Boolean)
    : [];

  return getPlanOpenStages(plan).map(stage => ({
    stage: stage.stage,
    times: String(stage.totalTimes ?? stage.times ?? 0),
    smart: true,
    trainingOperators: trainingOperatorNames
  }));
}

export function replaceSmartTrainingStages(task, smartStages = []) {
  const currentStages = task.params.stages || [];
  const pinnedStages = currentStages.filter(s => typeof s === 'object' && s.pinned && s.stage && s.stage.trim());
  const normalStages = currentStages.filter(s =>
    (typeof s === 'string' && s.trim()) ||
    (typeof s === 'object' && !s.pinned && !s.smart && s.stage && s.stage.trim())
  );

  task.params.stages = [...pinnedStages, ...smartStages, ...normalStages];
}

export function clearSmartTrainingStagesFromTask(task) {
  const currentStages = task.params.stages || [];
  const newStages = currentStages.filter(s => !(typeof s === 'object' && s.smart));
  task.params.stages = newStages.length > 0 ? newStages : [{ stage: '', times: '' }];
}

/**
 * 动态更新智能养成关卡
 * 在任务执行完成后，重新生成刷取计划并更新任务流程
 */
export async function updateSmartTrainingStages(scheduleId, {
  loadConfig = loadUserConfig,
  saveConfig = saveUserConfig,
  generateTrainingPlan = mode => operatorTrainingService.generateTrainingPlan(mode),
  runtimeLogger = logger
} = {}) {
  runtimeLogger.info('智能养成开始动态更新关卡', { scheduleId });

  try {
    // 1. 加载当前的任务流程配置
    const configResult = await loadConfig('automation-tasks');
    if (!configResult.success || !configResult.data || !configResult.data.taskFlow) {
      runtimeLogger.info('智能养成未找到任务流程配置，跳过更新', { scheduleId });
      return;
    }

    const { taskFlow } = configResult.data;

    // 2. 查找包含智能养成关卡的任务
    let hasSmartStages = false;
    let fightTaskIndex = -1;

    for (let i = 0; i < taskFlow.length; i++) {
      const task = taskFlow[i];
      if (task.commandId === 'fight' && task.params && task.params.stages) {
        const stages = task.params.stages;
        const smartStages = stages.filter(s => typeof s === 'object' && s.smart);
        if (smartStages.length > 0) {
          hasSmartStages = true;
          fightTaskIndex = i;
          break;
        }
      }
    }

    if (!hasSmartStages) {
      runtimeLogger.info('智能养成未找到智能养成关卡，跳过更新', { scheduleId });
      return;
    }

    runtimeLogger.info('智能养成找到智能养成关卡，开始重新生成刷取计划', { scheduleId });

    // 3. 加载养成队列
    const queueResult = await loadConfig('training-queue');
    if (!queueResult.success || !queueResult.data || !queueResult.data.queue || queueResult.data.queue.length === 0) {
      runtimeLogger.info('智能养成队列为空，移除所有智能养成关卡', { scheduleId });

      const task = taskFlow[fightTaskIndex];
      clearSmartTrainingStagesFromTask(task);

      await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
      runtimeLogger.success('智能养成已移除所有智能养成关卡', { scheduleId });
      return;
    }

    const trainingSettings = queueResult.data.settings || {};
    const shouldAutoSwitch = trainingSettings.autoSwitch !== false;

    // 4. 重新生成刷取计划（仅当前干员）
    const plan = await generateTrainingPlan('current');
    if (!plan || !plan.stages) {
      runtimeLogger.warn('智能养成生成刷取计划失败', { scheduleId });
      return;
    }

    const openSmartStages = buildSmartTrainingStages(plan);

    // 5. 检查是否还有需要刷的关卡
    if (plan.stages.length === 0) {
      runtimeLogger.info('智能养成当前干员材料已集齐，检查是否需要切换到下一个干员', { scheduleId });

      // 6. 自动切换到下一个干员
      const queue = queueResult.data.queue;
      if (shouldAutoSwitch && queue.length > 1) {
        // 移除第一个干员（已完成）
        const completedOperator = queue.shift();
        await saveConfig('training-queue', {
          ...queueResult.data,
          queue,
          settings: trainingSettings,
          lastUpdated: new Date().toISOString()
        });
        runtimeLogger.success('智能养成已切换到下一个干员', {
          scheduleId,
          completedOperator: completedOperator.name || completedOperator.operatorId,
          nextOperator: queue[0].name || queue[0].operatorId
        });

        // 重新生成刷取计划
        const newPlan = await generateTrainingPlan('current');
        const newSmartStages = buildSmartTrainingStages(newPlan || {});
        if (newPlan && newPlan.stages && newPlan.stages.length > 0 && newSmartStages.length > 0) {
          const task = taskFlow[fightTaskIndex];
          replaceSmartTrainingStages(task, newSmartStages);

          await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
          runtimeLogger.success('智能养成已更新智能养成关卡', {
            scheduleId,
            operators: newSmartStages[0]?.trainingOperators || [],
            stageCount: newSmartStages.length
          });
        } else {
          const task = taskFlow[fightTaskIndex];
          clearSmartTrainingStagesFromTask(task);

          await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
          runtimeLogger.info('智能养成新目标今天没有可刷关卡，已移除所有智能养成关卡', { scheduleId });
        }
      } else {
        runtimeLogger.info('智能养成不切换到下一个干员，移除所有智能养成关卡', {
          scheduleId,
          autoSwitch: shouldAutoSwitch,
          queueLength: queue.length
        });

        const task = taskFlow[fightTaskIndex];
        clearSmartTrainingStagesFromTask(task);

        await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
        runtimeLogger.success('智能养成已移除所有智能养成关卡', { scheduleId });
      }
    } else if (openSmartStages.length === 0) {
      runtimeLogger.info('智能养成当前计划今天没有开放关卡，移除所有智能养成关卡', {
        scheduleId,
        stageCount: plan.stages.length
      });

      const task = taskFlow[fightTaskIndex];
      clearSmartTrainingStagesFromTask(task);

      await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
    } else {
      // 7. 还有关卡需要刷，更新关卡和次数
      runtimeLogger.info('智能养成更新剩余关卡', {
        scheduleId,
        stageCount: openSmartStages.length
      });

      const task = taskFlow[fightTaskIndex];
      replaceSmartTrainingStages(task, openSmartStages);

      await saveConfig('automation-tasks', { taskFlow, schedule: configResult.data.schedule });
      runtimeLogger.success('智能养成已更新智能养成关卡', {
        scheduleId,
        stages: openSmartStages.map(s => `${s.stage}×${s.times}`)
      });
    }

  } catch (error) {
    runtimeLogger.error('智能养成动态更新失败', { scheduleId, error: error.message });
    throw error;
  }
}
