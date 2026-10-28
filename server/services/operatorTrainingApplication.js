/**
 * 养成计划应用与流程/定时同步
 *
 * 应用计划会写三处不同状态：自动化任务配置、训练队列中的应用标记、已注册的
 * 默认定时任务。三者可分别失败，调用方必须能识别部分成功：
 * - 队列写入 + 流程同步：返回 `queueUpdated` 与 `flowSync.status`；
 * - 配置与队列已落盘、定时注册失败：`scheduleSync.attempted=true, success=false`；
 * - 自动同步只改写智能关卡，不注册或重注册定时任务。
 *
 * 队列读写经 operatorTrainingStore，纯计算在 operatorTrainingModel/Plan。
 */

import { createLogger } from '../utils/logger.ts';
import {
  getApplicableStages,
  normalizeTrainingSettings,
  trainingError
} from './operatorTrainingModel.js';
import {
  getQueueRevision,
  loadTrainingQueue,
  readCombatTasksConfig,
  saveTrainingQueue,
  updateCombatTasksConfig
} from './operatorTrainingStore.js';
import { generateTrainingPlan } from './operatorTrainingPlan.js';

// 创建日志记录器（与养成领域其它模块共用同一命名 logger）
const logger = createLogger('OperatorTraining');

async function getFlowTarget(queueData, config = null) {
  config ??= await readCombatTasksConfig();
  const tasks = Array.isArray(config.taskFlow) ? config.taskFlow : [];
  const binding = queueData.trainingFlow;
  const boundTask = binding?.taskId ? tasks.find(task => task.id === binding.taskId && task.commandId === 'fight') : null;
  const smartTask = tasks.find(task => task.commandId === 'fight' && task.params?.stages?.some(stage => stage?.smart));
  const task = binding ? boundTask : smartTask || tasks.find(task => task.commandId === 'fight');
  return {
    config,
    task,
    taskIndex: tasks.indexOf(task),
    applied: Boolean(binding || smartTask),
    flowName: config.name || config.flowName || '自动任务',
    taskName: task?.name || binding?.taskName || '理智作战'
  };
}

function flowSyncStatus(queueData, target) {
  return {
    status: target.applied ? (queueData.trainingFlow?.status || 'synced') : 'not_applied',
    flowName: target.flowName,
    taskName: target.taskName,
    mode: queueData.trainingFlow?.mode || 'current',
    ...(queueData.trainingFlow?.error ? { error: queueData.trainingFlow.error } : {}),
    ...(queueData.trainingFlow?.syncedRevision ? { syncedRevision: queueData.trainingFlow.syncedRevision } : {})
  };
}

export async function getQueueFlowSync(queueData) {
  try {
    const target = await getFlowTarget(queueData);
    if (target.applied && !target.task) {
      return { ...flowSyncStatus(queueData, target), status: 'failed', error: '已应用的作战任务已被移除，请重新应用计划' };
    }
    if (queueData.flowSyncError) {
      return { ...flowSyncStatus(queueData, target), status: 'failed', error: queueData.flowSyncError };
    }
    return flowSyncStatus(queueData, target);
  } catch (error) {
    return {
      status: 'failed',
      flowName: queueData.trainingFlow?.flowName || '自动任务',
      taskName: queueData.trainingFlow?.taskName || '理智作战',
      error: error.message
    };
  }
}

/** Synchronize only a flow the user has already applied training to. */
export async function syncTrainingFlow(queueData = null) {
  queueData ??= await loadTrainingQueue();
  const queueRevision = getQueueRevision(queueData);
  try {
    const target = await getFlowTarget(queueData);
    if (!target.applied) {
      if (queueData.flowSyncError) {
        delete queueData.flowSyncError;
        await saveTrainingQueue(queueData);
      }
      return { queueUpdated: false, queueRevision, flowSync: flowSyncStatus(queueData, target) };
    }
    if (!target.task) throw new Error('已应用的作战任务已被移除，请重新应用计划');
    const mode = queueData.trainingFlow?.mode || 'current';
    const plan = queueData.queue.length > 0
      ? await generateTrainingPlan(mode)
      : { operators: [], stages: [], queueRevision, mode };
    const result = await applyPlanToTasks(plan, {}, { target, queueData, automatic: true });
    return { ...result, queueUpdated: false, queueRevision };
  } catch (error) {
    logger.error('队列已保存，但任务流程同步失败', { error: error.message });
    queueData.flowSyncError = error.message;
    if (queueData.trainingFlow) queueData.trainingFlow.status = 'failed';
    // The queue mutation is already committed. Failure to persist the diagnostic
    // must not turn a recoverable flow failure into an apparent queue failure.
    await saveTrainingQueue(queueData).catch(saveError => {
      logger.error('保存流程同步状态失败', { error: saveError.message });
    });
    return { queueUpdated: false, queueRevision, flowSync: await getQueueFlowSync(queueData) };
  }
}

export async function finishQueueMutation(queueData, extra = {}) {
  await saveTrainingQueue(queueData);
  const result = await syncTrainingFlow(queueData);
  return { ...extra, ...result, queueUpdated: true };
}

/**
 * 把 setupSchedule 的结果规范化为可上报的 scheduleSync。
 *
 * setupSchedule 在至少创建一个 job 时返回 success:true；若某个时间点的 cron
 * 创建失败，只有比较请求时间与返回的 times 才能发现。任何缺失时间点都视为
 * 部分失败，让客户端保留计划并提示用户重试。
 */
const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function summarizeScheduleSync(result, requestedTimes) {
  const appliedTimes = Array.isArray(result?.times) ? result.times : [];
  // 与 setupSchedule 一致：忽略非法值与重复项，避免把持久化旧数据误报为缺失时间。
  const normalizedRequested = [...new Set(
    requestedTimes.filter(time => typeof time === 'string' && scheduleTimePattern.test(time))
  )];
  const missingTimes = normalizedRequested.filter(time => !appliedTimes.includes(time));
  const baseMessage = typeof result?.message === 'string' ? result.message : null;
  return {
    attempted: true,
    success: Boolean(result?.success) && missingTimes.length === 0,
    message: missingTimes.length > 0
      ? `${baseMessage || '部分定时任务设置失败'}（未设置：${missingTimes.join('、')}）`
      : baseMessage,
    ...(missingTimes.length > 0 ? { missingTimes } : {})
  };
}

/**
 * 已注册的默认定时任务持有 setup 时的 taskFlow 快照。训练流程改写
 * automation-tasks 后必须重新注册，否则定时执行继续使用旧关卡；没有注册过的
 * 定时任务不会被这里顺带创建。
 *
 * 使用动态 import 避免 `schedulerService → operatorTrainingService` 的静态环。
 */
async function refreshRegisteredSchedule(config) {
  const { getScheduleStatus, setupSchedule, stopSchedule } = await import('./schedulerService.js');
  const registered = getScheduleStatus().some(entry => entry.scheduleId === 'default');
  if (!registered) return { attempted: false, success: true, message: null };

  const schedule = config?.schedule;
  const times = Array.isArray(schedule?.times) ? schedule.times : [];
  if (schedule?.enabled && times.length > 0) {
    const result = setupSchedule(
      'default',
      times,
      Array.isArray(config?.taskFlow) ? config.taskFlow : []
    );
    return summarizeScheduleSync(result, times);
  }

  // 配置已不需要定时执行，但进程内仍有注册：同步停止，避免继续按旧流程运行。
  const result = stopSchedule('default');
  return { attempted: true, success: Boolean(result?.success), message: result?.message || null };
}

/**
 * 应用养成计划到任务流程
 */
export async function applyPlanToTasks(plan, settings = {}, options = {}) {
  const queueData = options.queueData || await loadTrainingQueue();
  if (!plan.queueRevision || plan.queueRevision !== getQueueRevision(queueData)) {
    throw trainingError('养成队列已变化，请重新生成计划后应用', 409);
  }
  const effectiveSettings = normalizeTrainingSettings({ ...queueData.settings, ...settings });
  const applicableStages = getApplicableStages(plan);

  logger.info('开始应用养成计划');
  logger.debug('计划详情', {
    stageCount: plan.stages?.length || 0,
    applicableStageCount: applicableStages.length,
    operatorCount: plan.operators?.length || 0
  });

  try {
    let appliedResult;
    await updateCombatTasksConfig(async config => {

      logger.debug('成功读取现有配置', { taskCount: config.taskFlow?.length || 0 });

      // 查找或创建 fight 任务
      config.taskFlow = Array.isArray(config.taskFlow) ? config.taskFlow : [];
      let fightTask = options.automatic
        ? (options.target.task.id
            ? config.taskFlow.find(task => task.id === options.target.task.id && task.commandId === 'fight')
            : config.taskFlow[options.target.taskIndex])
        : (await getFlowTarget(queueData, config)).task;
      if (options.automatic && (!fightTask || fightTask.commandId !== 'fight')) {
        throw new Error('已应用的作战任务已被移除，请重新应用计划');
      }

      if (!fightTask) {
        fightTask = {
          id: `fight-${Date.now()}`,
          name: queueData.trainingFlow?.taskName || '理智作战',
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
      fightTask.id ||= `fight-${Date.now()}`;
      fightTask.params ||= {};

      // 获取现有的 stages，并分类
      const existingStages = fightTask.params.stages || [];
      const pinnedStages = existingStages.filter(s => s?.pinned && !s.smart);
      const normalStages = existingStages.filter(s => !s?.pinned && !s?.smart);

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
      if (queueData.queue.length > 0 && effectiveSettings.fallbackStage && effectiveSettings.fallbackStage.trim()) {
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

      appliedResult = {
        config,
        fightTask,
        smartStages,
        newStages,
        flowName: config.name || config.flowName || '自动任务'
      };
      return config;
    }, { taskFlow: [], schedule: { enabled: false, times: [] } });

    const { config, fightTask, smartStages, newStages, flowName } = appliedResult;
    queueData.settings = effectiveSettings;
    queueData.trainingFlow = {
      taskId: fightTask.id,
      taskName: fightTask.name || '理智作战',
      flowName,
      mode: plan.mode === 'all' ? 'all' : 'current',
      status: 'synced',
      syncedRevision: getQueueRevision(queueData)
    };
    delete queueData.flowSyncError;
    await saveTrainingQueue(queueData);

    // 配置与队列都已落盘；定时注册失败不回滚已生效的写入，而是作为部分失败上报，
    // 让客户端保留计划并给出重试入口。自动队列同步只改写智能关卡，不在这里
    // 顺带重注册定时任务（客户端计划应用才承诺同步 schedule）。
    const refreshSchedule = options.refreshSchedule
      ?? (options.automatic ? null : refreshRegisteredSchedule);
    let scheduleSync = { attempted: false, success: true, message: null };
    if (refreshSchedule) {
      try {
        scheduleSync = await refreshSchedule(config);
      } catch (error) {
        logger.error('定时任务刷新失败', { error: error.message });
        scheduleSync = { attempted: true, success: false, message: error.message };
      }
    }
    logger.success('养成计划应用成功');

    return {
      success: true,
      stageCount: smartStages.length,
      totalStages: newStages.length,
      hasFallback: queueData.queue.length > 0 && !!effectiveSettings.fallbackStage,
      flowName: queueData.trainingFlow.flowName,
      taskName: queueData.trainingFlow.taskName,
      flowSync: flowSyncStatus(queueData, { ...queueData.trainingFlow, applied: true }),
      scheduleSync
    };
  } catch (error) {
    logger.error('应用任务流程失败', { error: error.message });
    throw new Error('应用任务流程失败');
  }
}
