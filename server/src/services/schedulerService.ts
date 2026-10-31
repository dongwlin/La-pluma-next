import { resolveConnection } from './connectionService.ts';
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
} from './agentRunService.ts';
import { createDailyFlowExecutionError } from './agentActionService.ts';
import { buildScheduledTaskFlowPlan, validateScheduledTaskFlow } from './scheduleFlowPlan.ts';
import type { ScheduledTaskFlowPlanResult } from './scheduleFlowPlan.ts';
import { createScheduleFlowExecutor } from './scheduleFlowExecution.ts';
import type {
  ScheduleFlowExecutionOptions,
  ScheduleFlowExecutionResult,
  ScheduleFlowExecutor,
  ScheduleFlowLifecycle
} from './scheduleFlowExecution.ts';
import type { ScheduleExecutionStatus } from './scheduleFlowExecution.ts';
import type { FlowExecutionSummary } from './scheduleFlowResult.ts';
import { createScheduleExecutionPorts } from './scheduleExecutionPorts.ts';
import {
  attachScheduleTriggersToLifecycle as attachScheduleTriggers,
  createScheduleTriggerRuntime as createTriggerRuntime
} from './scheduleTriggerService.ts';
import type {
  AutoUpdateConfig,
  AutoUpdateSetupResult,
  ScheduleRegistrationStatus,
  ScheduleSetupResult,
  ScheduleTriggerLifecycle,
  ScheduleTriggerRuntime,
  ScheduleTriggerRuntimeOptions
} from './scheduleTriggerService.ts';

// 流程编排的组装入口：纯计划/结果聚合、步骤执行、cron 触发源分别由独立模块持有，
// 设备命令、通知与存储适配在端口模块接线。本模块只保留公开入口、Run 关联与
// 手动/定时执行共用的用例，保证同一进程内流程只有一个执行所有者。
//
// 类型边界：HTTP 与 cron 共用同一个执行器与生命周期门禁；Run 身份由调用方创建，
// 执行器只负责在取得租约后过准入、在结束时返回实际结果；终态写入（succeeded/
// failed/stopped）由本模块按实际结果结算，不由触发时机推断。

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

/** 测试与运行时装配可替换执行器；默认仍使用模块级单例。 */
export interface ScheduledFlowExecutionContext {
  executor?: ScheduleFlowExecutor;
}

/** 日常流程写入 Run 的结果：执行结果加上计划步骤数。 */
export interface ScheduledDailyFlowRunResult {
  success: boolean;
  message: string;
  stopped?: boolean;
  busy?: boolean;
  owner?: unknown;
  scheduleId: string;
  totalSteps: number;
  summary?: FlowExecutionSummary;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFieldOf(error: unknown, key: string): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
}

export async function getScheduledTaskFlowPlan(taskFlow: unknown): Promise<ScheduledTaskFlowPlanResult> {
  const validation = validateScheduledTaskFlow(taskFlow);
  if (!validation.success) return validation;

  const flow: unknown[] = Array.isArray(taskFlow) ? taskFlow : [];
  const needsConnection = flow.some(task => {
    const entry = task as Record<string, unknown>;
    if (!entry.enabled) return false;
    const commandId = entry.commandId || String(entry.id || '').split('-')[0];
    return commandId === 'startup' || commandId === 'closedown';
  });
  const connection = needsConnection ? await resolveConnection() : {};
  return buildScheduledTaskFlowPlan(taskFlow, connection);
}

/**
 * 获取定时任务执行状态
 */
export function getScheduleExecutionStatus(): ScheduleExecutionStatus {
  return scheduleFlowExecutor.getStatus();
}

/**
 * 停止当前正在执行的任务流程
 */
export function stopScheduleExecution(): boolean {
  return scheduleFlowExecutor.stop();
}

const ACTIVE_DAILY_FLOW_RUN_STATES = new Set<string>(['accepted', 'running', 'stopping']);

function settleDailyFlowRun(
  runId: string,
  result: ScheduledDailyFlowRunResult | null,
  error: unknown = null
) {
  try {
    const run = getAgentRun(runId);
    if (!run || !ACTIVE_DAILY_FLOW_RUN_STATES.has(run.state)) return;

    if (error) {
      if (errorFieldOf(error, 'stopped') || run.state === 'stopping') {
        stopAgentRun(runId, { message: errorFieldOf(error, 'message') || '任务流程已被终止' });
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
    logger.error('定时流程终态写入失败', { runId, error: errorMessageOf(settleError) });
  }
}

async function flushDailyFlowRunStore(context: string, runId: string) {
  try {
    await flushAgentRunStore();
  } catch (error) {
    logger.error(context, { runId, error: errorMessageOf(error) });
  }
}

/**
 * 完成通知与智能养成回写属于执行之后的副作用：租约已经释放、Run 已经结算后才运行。
 * 副作用失败只记录并返回错误，不把已经成功的执行改写成失败。
 */
async function dispatchCompletionEffects(
  executor: ScheduleFlowExecutor,
  result: ScheduleFlowExecutionResult,
  context: string
): Promise<void> {
  try {
    const completion = await executor.dispatchCompletion(result);
    if (!completion.performed) return;
    for (const error of completion.errors) logger.error(context, { error });
  } catch (error) {
    logger.error(context, { error: errorMessageOf(error) });
  }
}

export async function executeScheduledTaskFromCron(
  taskFlow: unknown,
  scheduleId: string,
  context: ScheduledFlowExecutionContext = {}
): Promise<ScheduleFlowExecutionResult> {
  const executor = context.executor || scheduleFlowExecutor;
  let runId: string | undefined;
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
    logger.error('定时任务未能获得 Run 身份，已跳过执行', { scheduleId, error: errorMessageOf(error) });
    if (runId) {
      try {
        failAgentRun(runId, error);
      } catch (settleError) {
        logger.error('定时流程准入失败终态写入失败', { runId, error: errorMessageOf(settleError) });
      }
      await flushDailyFlowRunStore('定时流程准入失败持久化失败', runId);
    }
    return { success: false, message: errorMessageOf(error) };
  }

  try {
    // 定时触发同样拥有 Run 身份：执行、终态结算与落盘日志都记录同一个
    // runId/operationId，关联生命周期跟随流程本身而不是触发时机。
    return await withExecutionLogContext({ runId, operationId: 'run_daily_flow' }, async () => {
      const result = await executor.execute(taskFlow, scheduleId, {
        onBeforeStart: () => startAgentRunForExecution(runId)
      }, { runId });
      const totalSteps = Array.isArray(taskFlow) ? taskFlow.filter(task => task?.enabled).length : 0;
      settleDailyFlowRun(runId, { ...result, scheduleId, totalSteps });
      await flushDailyFlowRunStore('定时流程终态持久化失败', runId);
      // Run 已落终态并完成持久化，设备租约也已在 execute 返回时释放；通知与
      // 智能养成回写不再位于执行关键路径。
      await dispatchCompletionEffects(executor, result, '定时流程完成副作用失败');
      return result;
    });
  } catch (error) {
    settleDailyFlowRun(runId, null, error);
    await flushDailyFlowRunStore('定时流程失败终态持久化失败', runId);
    logger.error('定时任务回调执行失败', { scheduleId, runId, error: errorMessageOf(error) });
    return { success: false, message: errorMessageOf(error) };
  }
}

/**
 * 创建定时触发源注册表。默认执行入口为日常流程与自动更新；测试可注入假 cron、
 * 假时钟与执行端口。
 */
export function createScheduleTriggerRuntime(
  options: ScheduleTriggerRuntimeOptions = {}
): ScheduleTriggerRuntime {
  return createTriggerRuntime({
    runScheduleFlow: executeScheduledTaskFromCron,
    ...options
  });
}

/**
 * 把触发源注册表接入运行时生命周期；默认使用本模块的进程内注册表。
 */
export function attachScheduleTriggersToLifecycle(
  lifecycle: ScheduleTriggerLifecycle | null | undefined,
  runtime: ScheduleTriggerRuntime = scheduleTriggerRuntime
): { attached: boolean; duplicate: boolean } {
  return attachScheduleTriggers(lifecycle, runtime);
}

// 创建或更新定时任务；重复配置同一 scheduleId 替换旧注册，不叠加 job。
// 日常流程按客户端服务区时区触发；未指定时使用连接默认客户端。
export function setupSchedule(
  scheduleId: string,
  times: unknown,
  taskFlow: unknown,
  clientType?: string
): ScheduleSetupResult {
  return scheduleTriggerRuntime.setupSchedule(scheduleId, times, taskFlow, clientType);
}

// 停止定时任务
export function stopSchedule(scheduleId: string): ScheduleSetupResult {
  return scheduleTriggerRuntime.stopSchedule(scheduleId);
}

// 获取所有定时任务状态
export function getScheduleStatus(): ScheduleRegistrationStatus[] {
  return scheduleTriggerRuntime.getStatus();
}

// 立即执行一次定时任务（用于测试）
export async function executeScheduleNow(
  scheduleId: string,
  taskFlow: unknown,
  lifecycle: ScheduleFlowLifecycle = {},
  options: ScheduleFlowExecutionOptions = {},
  context: ScheduledFlowExecutionContext = {}
): Promise<ScheduleFlowExecutionResult> {
  logger.info('手动触发执行', { scheduleId, runId: options.runId || null });
  const executor = context.executor || scheduleFlowExecutor;
  const result = await executor.execute(taskFlow, scheduleId, lifecycle, options);
  const runId = typeof options.runId === 'string' && options.runId ? options.runId : null;
  // 调用方（HTTP Run 结算或后台 onSettled）在 execute 返回后的微任务里写终态；
  // 把副作用放到下一轮事件循环，并先 flush Run 存储，避免通知/养成占用租约或
  // 早于 Run 终态落库。Telegram 等未纳管调用同样不阻塞命令响应。
  setImmediate(() => {
    void (async () => {
      if (runId) {
        try {
          await flushAgentRunStore();
        } catch (error) {
          logger.error('手动流程完成副作用前 Run 落盘失败', { runId, error: errorMessageOf(error) });
        }
      }
      await dispatchCompletionEffects(executor, result, '手动流程完成副作用失败');
    })();
  });
  return result;
}

// 自动更新任务：重复配置替换旧注册，禁用时停止并移除。
export function setupAutoUpdate(config: AutoUpdateConfig = {}): AutoUpdateSetupResult {
  return scheduleTriggerRuntime.setupAutoUpdate(config);
}

// 获取自动更新状态
export function getAutoUpdateStatus(): { enabled: boolean; time: string | null } {
  return scheduleTriggerRuntime.getAutoUpdateStatus();
}
