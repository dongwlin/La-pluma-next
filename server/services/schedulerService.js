import { resolveConnection } from './connectionService.js';
import { withExecutionLogContext } from '../utils/logContext.ts';
import { createLogger } from '../utils/logger.ts';
import {
  beginAgentRun,
  completeAgentRun,
  failAgentRun,
  flushAgentRunStore,
  getAgentRun,
  startAgentRunForExecution,
  stopAgentRun
} from './agentRunService.js';
import { createDailyFlowExecutionError } from './agentActionService.js';
import { buildScheduledTaskFlowPlan, validateScheduledTaskFlow } from './scheduleFlowPlan.js';
import { createScheduleFlowExecutor } from './scheduleFlowExecution.js';
import { createScheduleExecutionPorts } from './scheduleExecutionPorts.js';
import {
  attachScheduleTriggersToLifecycle as attachScheduleTriggers,
  createScheduleTriggerRuntime as createTriggerRuntime
} from './scheduleTriggerService.js';

// 流程编排的组装入口：纯计划/结果聚合、步骤执行、cron 触发源分别由独立模块持有，
// 设备命令、通知与存储适配在端口模块接线。本模块只保留公开入口、Run 关联与
// 手动/定时执行共用的用例，保证同一进程内流程只有一个执行所有者。

const logger = createLogger('Scheduler');

const scheduleFlowExecutor = createScheduleFlowExecutor({
  ports: createScheduleExecutionPorts()
});

// 进程内定时触发源注册表（cron 计划与自动更新共用）。关闭流程、测试通过工厂
// 注入假 cron 和假时钟，模块级函数仍保持既有调用面。
const scheduleTriggerRuntime = createTriggerRuntime({
  runScheduleFlow: executeScheduledTaskFromCron
});

export { buildScheduledTaskFlowPlan, validateScheduledTaskFlow };

export async function getScheduledTaskFlowPlan(taskFlow) {
  const validation = validateScheduledTaskFlow(taskFlow);
  if (!validation.success) return validation;

  const needsConnection = Array.isArray(taskFlow) && taskFlow.some(task => {
    if (!task.enabled) return false;
    const commandId = task.commandId || String(task.id || '').split('-')[0];
    return commandId === 'startup' || commandId === 'closedown';
  });
  const connection = needsConnection ? await resolveConnection() : {};
  return buildScheduledTaskFlowPlan(taskFlow, connection);
}

/**
 * 获取定时任务执行状态
 */
export function getScheduleExecutionStatus() {
  return scheduleFlowExecutor.getStatus();
}

/**
 * 停止当前正在执行的任务流程
 */
export function stopScheduleExecution() {
  return scheduleFlowExecutor.stop();
}

const ACTIVE_DAILY_FLOW_RUN_STATES = new Set(['accepted', 'running', 'stopping']);

function settleDailyFlowRun(runId, result, error = null) {
  try {
    const run = getAgentRun(runId);
    if (!run || !ACTIVE_DAILY_FLOW_RUN_STATES.has(run.state)) return;

    if (error) {
      if (error.stopped || run.state === 'stopping') {
        stopAgentRun(runId, { message: error.message || '任务流程已被终止' });
      } else {
        failAgentRun(runId, error);
      }
      return;
    }
    if (result?.stopped || run.state === 'stopping') {
      stopAgentRun(runId, result);
      return;
    }
    if (result?.success === false) {
      failAgentRun(runId, createDailyFlowExecutionError(result) || new Error(result.message || '任务流程未能执行'));
      return;
    }
    completeAgentRun(runId, result);
  } catch (settleError) {
    logger.error('定时流程终态写入失败', { runId, error: settleError.message });
  }
}

async function flushDailyFlowRunStore(context, runId) {
  try {
    await flushAgentRunStore();
  } catch (error) {
    logger.error(context, { runId, error: error.message });
  }
}

export async function executeScheduledTaskFromCron(taskFlow, scheduleId) {
  let runId;
  try {
    const reservation = beginAgentRun({
      operationId: 'run_daily_flow',
      input: { scheduleId, taskFlow },
      metadata: {
        taskName: `定时流程 ${scheduleId}`,
        taskType: 'schedule',
        scheduleId,
        trigger: 'cron'
      }
    });
    runId = reservation.run.runId;
    await flushAgentRunStore();
  } catch (error) {
    logger.error('定时任务未能获得 Run 身份，已跳过执行', { scheduleId, error: error.message });
    if (runId) {
      try {
        failAgentRun(runId, error);
      } catch (settleError) {
        logger.error('定时流程准入失败终态写入失败', { runId, error: settleError.message });
      }
      await flushDailyFlowRunStore('定时流程准入失败持久化失败', runId);
    }
    return { success: false, message: error.message };
  }

  try {
    // 定时触发同样拥有 Run 身份：执行、终态结算与落盘日志都记录同一个
    // runId/operationId，关联生命周期跟随流程本身而不是触发时机。
    return await withExecutionLogContext({ runId, operationId: 'run_daily_flow' }, async () => {
      const result = await scheduleFlowExecutor.execute(taskFlow, scheduleId, {
        onBeforeStart: () => startAgentRunForExecution(runId)
      }, { runId });
      const totalSteps = Array.isArray(taskFlow) ? taskFlow.filter(task => task?.enabled).length : 0;
      settleDailyFlowRun(runId, { ...result, scheduleId, totalSteps });
      await flushDailyFlowRunStore('定时流程终态持久化失败', runId);
      return result;
    });
  } catch (error) {
    settleDailyFlowRun(runId, null, error);
    await flushDailyFlowRunStore('定时流程失败终态持久化失败', runId);
    logger.error('定时任务回调执行失败', { scheduleId, runId, error: error.message });
    return { success: false, message: error.message };
  }
}

/**
 * 创建定时触发源注册表。默认执行入口为日常流程与自动更新；测试可注入假 cron、
 * 假时钟与执行端口。
 */
export function createScheduleTriggerRuntime(options = {}) {
  return createTriggerRuntime({
    runScheduleFlow: executeScheduledTaskFromCron,
    ...options
  });
}

/**
 * 把触发源注册表接入运行时生命周期；默认使用本模块的进程内注册表。
 */
export function attachScheduleTriggersToLifecycle(lifecycle, runtime = scheduleTriggerRuntime) {
  return attachScheduleTriggers(lifecycle, runtime);
}

// 创建或更新定时任务；重复配置同一 scheduleId 替换旧注册，不叠加 job。
export function setupSchedule(scheduleId, times, taskFlow) {
  return scheduleTriggerRuntime.setupSchedule(scheduleId, times, taskFlow);
}

// 停止定时任务
export function stopSchedule(scheduleId) {
  return scheduleTriggerRuntime.stopSchedule(scheduleId);
}

// 获取所有定时任务状态
export function getScheduleStatus() {
  return scheduleTriggerRuntime.getStatus();
}

// 立即执行一次定时任务（用于测试）
export async function executeScheduleNow(scheduleId, taskFlow, lifecycle = {}, options = {}) {
  logger.info('手动触发执行', { scheduleId, runId: options.runId || null });
  return await scheduleFlowExecutor.execute(taskFlow, scheduleId, lifecycle, options);
}

// 自动更新任务：重复配置替换旧注册，禁用时停止并移除。
export function setupAutoUpdate(config) {
  return scheduleTriggerRuntime.setupAutoUpdate(config);
}

// 获取自动更新状态
export function getAutoUpdateStatus() {
  return scheduleTriggerRuntime.getAutoUpdateStatus();
}
