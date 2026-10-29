import { createScheduleTaskProgress } from './scheduleTaskProgress.ts';
import type { ScheduleTaskProgress, ScheduleTaskProgressResult } from './scheduleTaskProgress.ts';
import { buildScheduledTaskCommand, validateScheduledTaskFlow } from './scheduleFlowPlan.ts';
import type { ScheduledTask, ScheduledTaskParams } from './scheduleFlowPlan.ts';
import { buildFlowExecutionOutcome, getFightReportResults, parseTaskSummary } from './scheduleFlowResult.ts';
import type {
  FightReportResult,
  FlowExecutionSummary,
  FlowTaskError,
  FlowTaskSkip,
  FlowTaskSummary,
  ScheduleStepAction
} from './scheduleFlowResult.ts';
import { getEnabledAwardItems, parseAwardExecutionActions } from './awardResultService.ts';
import { parseRecruitExecutionAction } from './recruitResultService.ts';
import { parseInfrastExecutionAction } from './infrastResultService.ts';
import { parseMallExecutionAction } from './mallResultService.ts';
import { createFightExecutionAction, isFightSanityDepleted } from './fightResultService.ts';
import type { FightExecutionAction } from './fightResultService.ts';
import type { MaaLogCheckpoint } from './maaLogFileService.ts';
import type { MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import type { DropRecordInput } from './dropRecordService.ts';
import type { StageOpenState, TaskCompletionInfo } from './notificationService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { createLogger } from '../utils/logger.ts';

/**
 * 流程执行器
 *
 * 类型边界：
 * - 步骤结论是 `success`/`failed`/`skipped` 的有穷联合；执行被终止时进度记
 *   `stopped`，不会把取消伪装成失败；
 * - 日志检查点是 `MaaLogCheckpoint | null`，执行后只读取检查点之后的新增日志，
 *   旧任务日志不进入当前结果；
 * - 设备命令、通知、掉落记录与养成回写全部经端口注入，执行规则本身不直接
 *   读写设备、用户配置或通知实现；
 * - 同一进程只创建一个实例，异步流程只有一个执行所有者。
 */

/**
 * 执行只需要连接地址、ADB 路径与客户端类型；profile 解析仍由连接服务负责。
 * `clientType` 可选：任务参数或连接 profile 未提供时按连接默认值判定游戏日。
 */
export interface ScheduleConnection {
  adbPath: string;
  address: string;
  clientType?: string;
}

/** 命令输出：流程只读取 stdout/stderr 文本。 */
export interface ScheduleCommandOutput {
  stdout: string;
  stderr: string;
}

export interface ScheduleAdbTestResult {
  success: boolean;
  message?: string;
}

export interface ScheduleGameClientState {
  running: boolean;
  foregroundPackage?: string | null;
}

export interface ScheduleCapturedScreen {
  image: string;
}

/** 仓库识别结果：流程只读取成功标志与条目数。 */
export interface ScheduleDepotParseResult {
  success: boolean;
  itemCount?: number;
}

export interface ScheduleStageOpenState {
  isOpen: boolean;
  reason?: string | null;
}

/**
 * 流程执行端口：设备命令、日志检查点、通知与存储适配集中在组装处接线。
 * 端口签名只描述执行器实际读取的字段；测试可传入假端口验证步骤结果，
 * 不需要 MAA CLI、ADB 或真实数据目录。
 */
export interface ScheduleExecutionPorts {
  executeCommand(
    command: string,
    args: readonly string[],
    taskName: string | null,
    taskType: string | null,
    waitForCompletion: boolean
  ): Promise<ScheduleCommandOutput>;
  executeDynamicTask(
    taskId: string,
    taskConfig: string,
    taskName: string | null,
    taskType: string | null,
    waitForCompletion: boolean
  ): Promise<ScheduleCommandOutput>;
  createLogCheckpoint(): Promise<MaaLogCheckpoint | null>;
  readLogSince(checkpoint: MaaLogCheckpoint | null): Promise<string>;
  resolveConnection(): Promise<ScheduleConnection>;
  testConnection(adbPath: string, address: string): Promise<ScheduleAdbTestResult>;
  getGameClientState(adbPath: string, address: string, clientType: string): Promise<ScheduleGameClientState>;
  captureScreen(adbPath: string, address: string): Promise<ScheduleCapturedScreen>;
  replaceActivityCode(stage: string, clientType: string): Promise<string>;
  isStageOpenToday(stage: string, clientType: string): ScheduleStageOpenState | Promise<ScheduleStageOpenState>;
  shouldCaptureNotificationScreenshot(): boolean;
  sendCompletionNotification(info: TaskCompletionInfo): Promise<unknown>;
  recordDrops(input: DropRecordInput): Promise<unknown>;
  parseDepotData(): Promise<ScheduleDepotParseResult | null>;
  refreshSmartTrainingStages(scheduleId: string): Promise<unknown>;
  withExecutionLease<T>(request: MaaExecutionLeaseRequest, run: () => Promise<T>): Promise<T>;
}

export interface ScheduleFlowLogger {
  info(message: string, data?: unknown): unknown;
  warn(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
  debug(message: string, data?: unknown): unknown;
  success(message: string, data?: unknown): unknown;
}

/** 执行前后门禁：onBeforeStart 在取得租约后、第一步之前运行。 */
export interface ScheduleFlowLifecycle {
  onBeforeStart?(): unknown;
  onStarted?(): unknown;
}

export interface ScheduleFlowExecutionOptions {
  /** Run 身份来自调用方；非字符串或空串按未关联处理。 */
  runId?: unknown;
}

/** 轮询投影：进度、当前步骤与最近一次汇总，不携带设备句柄。 */
export interface ScheduleExecutionStatus {
  isRunning: boolean;
  scheduleId: string | null;
  runId: string | null;
  currentStep: number;
  totalSteps: number;
  currentTask: string | null;
  currentTaskId: string | null;
  message: string;
  startTime: number | null;
  shouldStop: boolean;
  lastResult: FlowExecutionSummary | null;
  taskResults: ScheduleTaskProgressResult[];
}

/** 拒绝执行的原因保留 busy/owner，供 HTTP 映射 409 与外部占用提示。 */
export interface ScheduleFlowRejectedResult {
  success: false;
  message: string;
  busy?: boolean;
  owner?: unknown;
}

/** 正常完成或被用户终止；两者都由实际执行收尾。 */
export interface ScheduleFlowCompletedResult {
  success: true;
  stopped: boolean;
  message: string;
  summary: FlowExecutionSummary;
}

export type ScheduleFlowExecutionResult = ScheduleFlowRejectedResult | ScheduleFlowCompletedResult;

export interface ScheduleFlowExecutor {
  execute(
    taskFlow: unknown,
    scheduleId: string,
    lifecycle?: ScheduleFlowLifecycle,
    options?: ScheduleFlowExecutionOptions
  ): Promise<ScheduleFlowExecutionResult>;
  getStatus(): ScheduleExecutionStatus;
  stop(): boolean;
}

export interface ScheduleFlowExecutorOptions {
  /** 端口缺省时仍按名称逐个校验，缺端口在构造期报错。 */
  ports?: Partial<ScheduleExecutionPorts>;
  logger?: ScheduleFlowLogger;
}

const REQUIRED_PORTS: readonly (keyof ScheduleExecutionPorts)[] = [
  'executeCommand',
  'executeDynamicTask',
  'createLogCheckpoint',
  'readLogSince',
  'resolveConnection',
  'testConnection',
  'getGameClientState',
  'captureScreen',
  'replaceActivityCode',
  'isStageOpenToday',
  'shouldCaptureNotificationScreenshot',
  'sendCompletionNotification',
  'recordDrops',
  'parseDepotData',
  'refreshSmartTrainingStages',
  'withExecutionLease'
];

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFieldOf(error: unknown, key: string): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
}

/** 错误对象上的命令输出按文本读取；非对象错误没有输出。 */
function errorOutputOf(error: unknown): string {
  return String(errorFieldOf(error, 'stdout') || '') + String(errorFieldOf(error, 'stderr') || '');
}

/** 失败任务的配置关卡：第一段关卡对象的 stage 优先，其次单关卡 stage。 */
function configuredStageOf(params: ScheduledTaskParams | undefined): string {
  const first = params?.stages?.[0];
  const stage = first && typeof first === 'object' ? first.stage : undefined;
  return String(stage || params?.stage || '');
}

/**
 * 创建流程执行器。每个实例独占一份执行状态、停止信号和任务进度，
 * 同一进程只应在组装处创建一个实例，保证异步流程只有一个执行所有者。
 */
export function createScheduleFlowExecutor(options: ScheduleFlowExecutorOptions = {}): ScheduleFlowExecutor {
  const { ports, logger = createLogger('Scheduler') } = options;
  for (const name of REQUIRED_PORTS) {
    if (typeof ports?.[name] !== 'function') {
      throw new TypeError(`createScheduleFlowExecutor 缺少执行端口: ${name}`);
    }
  }

  // 端口名已逐个验证为函数；此处按完整契约读取，缺省实现由组装处提供。
  const {
    executeCommand,
    executeDynamicTask,
    createLogCheckpoint,
    readLogSince,
    resolveConnection,
    testConnection,
    getGameClientState,
    captureScreen,
    replaceActivityCode,
    isStageOpenToday,
    shouldCaptureNotificationScreenshot,
    sendCompletionNotification,
    recordDrops,
    parseDepotData,
    refreshSmartTrainingStages,
    withExecutionLease
  } = ports as ScheduleExecutionPorts;

  // 定时任务执行状态
  const executionStatus: ScheduleExecutionStatus = {
    isRunning: false,
    scheduleId: null,
    runId: null,
    currentStep: -1,
    totalSteps: 0,
    currentTask: null,
    currentTaskId: null,
    message: '',
    startTime: null,
    shouldStop: false,
    lastResult: null,
    taskResults: []
  };

  let cancelActiveDelay: (() => void) | null = null;
  let activeAbortController: AbortController | null = null;
  let activeExecutionToken: symbol | null = null;
  let activeTaskProgress: ScheduleTaskProgress | null = null;

  function waitForDelay(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const signal = activeAbortController?.signal;

      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener('abort', cancel);
        if (cancelActiveDelay === cancel) cancelActiveDelay = null;
        resolve(completed);
      };

      const cancel = () => finish(false);
      cancelActiveDelay = cancel;
      timeoutId = setTimeout(() => finish(true), delayMs);
      signal?.addEventListener('abort', cancel, { once: true });

      if (executionStatus.shouldStop) cancel();
    });
  }

  /**
   * 获取定时任务执行状态
   */
  function getStatus(): ScheduleExecutionStatus {
    return { ...executionStatus };
  }

  /**
   * 停止当前正在执行的任务流程
   */
  function stop(): boolean {
    if (executionStatus.isRunning) {
      logger.warn('设置停止标志，正在终止任务流程');
      updateStatus({
        shouldStop: true,
        message: '正在终止任务流程'
      });
      activeAbortController?.abort(new Error('任务流程已被用户终止'));
      cancelActiveDelay?.();
      return true;
    }
    return false;
  }

  /**
   * 更新定时任务执行状态
   */
  function updateStatus(updates: Partial<ScheduleExecutionStatus>) {
    Object.assign(executionStatus, updates);
    logger.debug('定时任务状态更新', executionStatus);
  }

  async function recordFightDrops(summary: FlowTaskSummary | null, scheduleId: string) {
    if (!summary || !summary.stage || !Array.isArray(summary.dropItems) || summary.dropItems.length === 0) return;

    try {
      const times = Math.max(1, Number(summary.times) || 1);
      await recordDrops({
        stage: summary.stage,
        times,
        items: summary.dropItems,
        sanity: times * 20,
        medicine: Math.max(0, Number(summary.medicine) || 0),
        stone: Math.max(0, Number(summary.stone) || 0)
      });
      logger.debug('掉落记录已保存', { scheduleId, stage: summary.stage });
    } catch (error) {
      logger.error('掉落记录保存失败', { scheduleId, error: errorMessageOf(error) });
    }
  }

  // 执行任务流程
  async function runTaskFlow(
    taskFlow: unknown,
    scheduleId: string,
    executionToken: symbol,
    lifecycle: ScheduleFlowLifecycle = {},
    runId: string | null = null
  ): Promise<ScheduleFlowExecutionResult> {
    if (!Array.isArray(taskFlow)) {
      return { success: false, message: '任务流程格式无效' };
    }

    if (executionStatus.isRunning) {
      logger.warn('任务流程已在执行，忽略重复触发', {
        activeScheduleId: executionStatus.scheduleId,
        requestedScheduleId: scheduleId
      });
      return { success: false, message: '已有任务流程正在执行' };
    }

    const validation = validateScheduledTaskFlow(taskFlow);
    if (!validation.success) return validation;

    const tasks = taskFlow as ScheduledTask[];

    logger.info('开始执行任务流程', { scheduleId, runId });
    activeExecutionToken = executionToken;
    const abortController = new AbortController();
    activeAbortController = abortController;

    // 更新状态：开始执行
    updateStatus({
      isRunning: true,
      scheduleId,
      runId,
      currentStep: -1,
      totalSteps: tasks.filter(t => t.enabled).length,
      currentTask: null,
      currentTaskId: null,
      message: '开始执行任务流程',
      startTime: Date.now(),
      shouldStop: false,  // 重置停止标志
      lastResult: null,
      taskResults: []
    });

    // The pre-start gate runs after the flow owns the lease and the scheduler
    // status is live, so a concurrent stop either aborts here or sets shouldStop.
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();

    const startTime = Date.now();
    const enabledTasks = tasks.filter(t => t.enabled);
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const errors: FlowTaskError[] = [];
    const skipped: FlowTaskSkip[] = [];
    const taskSummaries: FlowTaskSummary[] = []; // 收集任务总结信息
    const reportResults: FightReportResult[] = [];
    const executionWarnings = new Set<string>();
    const actionResults: ScheduleStepAction[] = [];
    // 作战动作单独保留引用，多关卡计数只统计本任务新增的作战结论。
    const fightActions: FightExecutionAction[] = [];
    const addFightAction = (action: FightExecutionAction) => {
      actionResults.push(action);
      fightActions.push(action);
      if (action.status === 'failed') {
        errors.push({ task: action.task, error: action.message });
      } else if (action.status === 'skipped') {
        skipped.push({ task: action.task, reason: action.message });
      }
    };
    const countFightTaskResult = (actions: FightExecutionAction[]) => {
      if (actions.some(action => action.status === 'failed')) failedCount++;
      else if (actions.some(action => action.status === 'success')) successCount++;
      else skippedCount++;
    };
    let screenshot: string | null = null;
    const taskProgress = createScheduleTaskProgress(
      enabledTasks,
      () => ({ successCount, failedCount, skippedCount }),
      results => updateStatus({ taskResults: results })
    );
    activeTaskProgress = taskProgress;
    const sharedConnection = await resolveConnection();
    const adbConfig = {
      adbPath: sharedConnection.adbPath,
      address: sharedConnection.address
    };

    for (let i = 0; i < enabledTasks.length; i++) {
      taskProgress.finish({ stopped: executionStatus.shouldStop });
      // 检查是否需要停止
      if (executionStatus.shouldStop) {
        logger.warn('检测到停止信号，终止任务流程', { scheduleId });
        updateStatus({
          message: '任务流程已被用户终止'
        });
        break;
      }

      const task = enabledTasks[i];
      const commandId = task.commandId || task.id.split('-')[0];
      taskProgress.start(task.id);

      logger.info('执行任务', {
        scheduleId,
        taskIndex: i + 1,
        totalTasks: enabledTasks.length,
        taskName: task.name
      });

      // 更新状态：执行中
      updateStatus({
        currentStep: i,
        currentTask: task.name,
        currentTaskId: task.id, // 添加任务 ID
        message: `正在执行: ${task.name} (${i + 1}/${enabledTasks.length})`
      });

      if (commandId === 'award') {
        try {
          const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const enabledAwardItems = getEnabledAwardItems(task.params);

          if (enabledAwardItems.length === 0) {
            skippedCount++;
            skipped.push({ task: task.name, reason: '未启用任何领取项目' });
            actionResults.push(...parseAwardExecutionActions(task.name, task.params));
            continue;
          }

          const logCheckpoint = await createLogCheckpoint();
          let result: ScheduleCommandOutput;

          if (taskConfig) {
            const taskId = params;
            result = await executeDynamicTask(taskId, taskConfig, task.name, null, true);
          } else {
            const args = params ? params.split(' ').filter(arg => arg) : [];
            result = await executeCommand(command, args, task.name, null, true);
          }

          if (result?.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) taskSummaries.push(summary);
          }

          const awardActions = parseAwardExecutionActions(
            task.name,
            task.params,
            await readLogSince(logCheckpoint)
          );
          actionResults.push(...awardActions);
          if (awardActions.some(action => action.status === 'success')) successCount++;
          else skippedCount++;

          if (shouldCaptureNotificationScreenshot()) {
            logger.info('图片通知已启用，领取奖励完成后截图', { scheduleId });
            const screenshotDelayCompleted = await waitForDelay(2000);
            if (!screenshotDelayCompleted) break;
            try {
              const screenshotResult = await captureScreen(adbConfig.adbPath, adbConfig.address);
              screenshot = screenshotResult.image;
              logger.success('通知截图成功', { scheduleId });
            } catch (error) {
              logger.error('通知截图失败', { scheduleId, error: errorMessageOf(error) });
            }
          }

          const delayCompleted = await waitForDelay(2000);
          if (!delayCompleted) break;
          continue;
        } catch (error) {
          failedCount++;
          errors.push({ task: task.name, error: errorMessageOf(error) });
          actionResults.push({
            task: task.name,
            action: 'award',
            status: 'failed',
            message: `领取奖励失败：${errorMessageOf(error)}`
          });
          logger.error('任务执行失败', {
            scheduleId,
            taskName: task.name,
            error: errorMessageOf(error)
          });
          continue;
        }
      }

      // 关闭前仓库识别是可选步骤，不再作为隐藏的强制行为。
      if (commandId === 'closedown' && task.params?.recognizeDepotBeforeClose === true) {
        // 识别仓库
        try {
          logger.info('关闭游戏前先识别仓库', { scheduleId });

          // 等待3秒确保游戏回到主界面
          logger.debug('等待游戏回到主界面', { scheduleId, waitSeconds: 3 });
          await new Promise(resolve => setTimeout(resolve, 3000));

          updateStatus({
            message: '正在识别仓库...'
          });

          // 构建 Depot 任务配置
          const depotTaskConfig = {
            name: '仓库识别',
            type: 'Depot',
            params: {
              enable: true
            }
          };

          // execDynamicTask 需要 JSON 字符串
          // execDynamicTask 成功时不抛出异常，失败时抛出异常
          try {
            await executeDynamicTask('Depot_temp', JSON.stringify(depotTaskConfig), '仓库识别', 'depot', true);
            logger.success('仓库识别命令执行完成', { scheduleId });

            // 解析并保存仓库数据
            logger.debug('开始解析仓库数据', { scheduleId });
            const parseResult = await parseDepotData();
            if (parseResult && parseResult.success) {
              logger.success('仓库数据已保存', {
                scheduleId,
                itemCount: parseResult.itemCount
              });
              actionResults.push({
                task: task.name,
                action: 'depot',
                status: 'success',
                message: `关闭前仓库识别完成，共 ${parseResult.itemCount || 0} 项`
              });
            } else {
              logger.warn('仓库数据解析失败', { scheduleId });
              actionResults.push({
                task: task.name,
                action: 'depot',
                status: 'failed',
                message: '关闭前仓库识别完成，但数据解析失败'
              });
            }
          } catch (depotError) {
            logger.error('仓库识别失败', {
              scheduleId,
              error: errorMessageOf(depotError)
            });
            actionResults.push({
              task: task.name,
              action: 'depot',
              status: 'failed',
              message: `关闭前仓库识别失败：${errorMessageOf(depotError)}`
            });
            // 即使识别失败也继续执行后续任务
          }

          // 等待2秒
          logger.debug('等待后继续', { scheduleId, waitSeconds: 2 });
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          logger.error('仓库识别异常', {
            scheduleId,
            error: errorMessageOf(error)
          });
          actionResults.push({
            task: task.name,
            action: 'depot',
            status: 'failed',
            message: `关闭前仓库识别异常：${errorMessageOf(error)}`
          });
          // 即使识别失败也继续
        }
      }

      // 如果是启动游戏任务，添加重试机制
      if (commandId === 'startup') {
        const connectionCheck = await testConnection(adbConfig.adbPath, adbConfig.address);
        if (!connectionCheck.success) {
          const errorMessage = connectionCheck.message || '模拟器连接失败';
          failedCount++;
          errors.push({ task: task.name, error: errorMessage });
          actionResults.push({
            task: task.name,
            action: 'startup',
            status: 'failed',
            message: errorMessage
          });
          logger.error('启动游戏前连接检查失败', { scheduleId, error: errorMessage });
          continue;
        }

        const maxRetries = 2;
        let retryCount = 0;
        let startupSuccess = false;

        while (retryCount <= maxRetries && !startupSuccess) {
          try {
            if (retryCount > 0) {
              logger.info('启动游戏重试', {
                scheduleId,
                retryCount,
                maxRetries
              });
              await new Promise(resolve => setTimeout(resolve, 3000)); // 重试前等待3秒
            }

            const { command, params } = buildScheduledTaskCommand(task, adbConfig);
            const args = params ? params.split(' ').filter(arg => arg) : [];
            await executeCommand(command, args, task.name, null, true);

            logger.info('启动游戏命令执行完成', { scheduleId });

            // 同时检查前台包名和截图，避免游戏闪退到模拟器桌面后被误判为成功。
            try {
              logger.debug('检测游戏是否运行中', { scheduleId });
              const gameState = await getGameClientState(
                adbConfig.adbPath,
                adbConfig.address,
                task.params.clientType || DEFAULT_CLIENT_TYPE
              );
              if (!gameState.running) {
                throw new Error(`游戏未在前台，当前应用：${gameState.foregroundPackage || '未知'}`);
              }
              await captureScreen(adbConfig.adbPath, adbConfig.address);
              logger.success('游戏运行正常', { scheduleId });
              startupSuccess = true;
              successCount++;
              actionResults.push({
                task: task.name,
                action: 'startup',
                status: 'success',
                message: task.params.accountName
                  ? `游戏已启动，账号 ${task.params.accountName} 已匹配`
                  : '游戏已启动并进入前台'
              });
            } catch (error) {
              logger.error('游戏可能已闪退', {
                scheduleId,
                error: errorMessageOf(error)
              });
              retryCount++;
              if (retryCount > maxRetries) {
                throw new Error('游戏启动后闪退，已达到最大重试次数');
              }
            }
          } catch (error) {
            if (retryCount >= maxRetries) {
              failedCount++;
              errors.push({ task: task.name, error: errorMessageOf(error) });
              actionResults.push({
                task: task.name,
                action: 'startup',
                status: 'failed',
                message: errorMessageOf(error)
              });
              logger.error('任务执行失败', {
                scheduleId,
                taskName: task.name,
                error: errorMessageOf(error)
              });
              break;
            }
            retryCount++;
          }
        }

        // 启动游戏任务已处理完成，继续下一个任务
        continue;
      }

      if (commandId === 'recruit') {
        try {
          const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const logCheckpoint = await createLogCheckpoint();
          let result: ScheduleCommandOutput;

          if (taskConfig) {
            result = await executeDynamicTask(params, taskConfig, task.name, null, true);
          } else {
            const args = params ? params.split(' ').filter(arg => arg) : [];
            result = await executeCommand(command, args, task.name, null, true);
          }

          if (result?.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) taskSummaries.push(summary);
          }

          const recruitAction = parseRecruitExecutionAction(
            task.name,
            task.params,
            await readLogSince(logCheckpoint)
          );
          actionResults.push(recruitAction);

          if (recruitAction.status === 'failed') {
            failedCount++;
            errors.push({ task: task.name, error: recruitAction.message });
          } else if (recruitAction.status === 'skipped') {
            skippedCount++;
            skipped.push({ task: task.name, reason: recruitAction.message });
          } else {
            successCount++;
          }

          const delayCompleted = await waitForDelay(2000);
          if (!delayCompleted) break;
          continue;
        } catch (error) {
          if (executionStatus.shouldStop) break;
          failedCount++;
          errors.push({ task: task.name, error: errorMessageOf(error) });
          actionResults.push({
            task: task.name,
            action: 'recruit',
            status: 'failed',
            message: `自动公招失败：${errorMessageOf(error)}`
          });
          logger.error('自动公招执行失败', { scheduleId, taskName: task.name, error: errorMessageOf(error) });
          continue;
        }
      }

      if (commandId === 'infrast') {
        try {
          const facility = task.params?.facility;
          if (!Array.isArray(facility) || facility.length === 0) {
            const infrastAction = parseInfrastExecutionAction(task.name, task.params);
            skippedCount++;
            skipped.push({ task: task.name, reason: infrastAction.message });
            actionResults.push(infrastAction);
            continue;
          }

          const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const logCheckpoint = await createLogCheckpoint();
          let result: ScheduleCommandOutput;

          if (taskConfig) {
            result = await executeDynamicTask(params, taskConfig, task.name, null, true);
          } else {
            const args = params ? params.split(' ').filter(arg => arg) : [];
            result = await executeCommand(command, args, task.name, null, true);
          }

          if (result?.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) taskSummaries.push(summary);
          }

          const infrastAction = parseInfrastExecutionAction(
            task.name,
            task.params,
            await readLogSince(logCheckpoint)
          );
          actionResults.push(infrastAction);

          if (infrastAction.status === 'failed') {
            failedCount++;
            errors.push({ task: task.name, error: infrastAction.message });
          } else if (infrastAction.status === 'skipped') {
            skippedCount++;
            skipped.push({ task: task.name, reason: infrastAction.message });
          } else {
            successCount++;
          }

          const delayCompleted = await waitForDelay(2000);
          if (!delayCompleted) break;
          continue;
        } catch (error) {
          if (executionStatus.shouldStop) break;
          failedCount++;
          errors.push({ task: task.name, error: errorMessageOf(error) });
          actionResults.push({
            task: task.name,
            action: 'infrast',
            status: 'failed',
            message: `基建任务失败：${errorMessageOf(error)}`
          });
          logger.error('基建任务执行失败', { scheduleId, taskName: task.name, error: errorMessageOf(error) });
          continue;
        }
      }

      if (commandId === 'mall') {
        try {
          if (task.params?.visit_friends === false
            && task.params?.shopping === false
            && task.params?.credit_fight === false) {
            const mallAction = parseMallExecutionAction(task.name, task.params);
            skippedCount++;
            skipped.push({ task: task.name, reason: mallAction.message });
            actionResults.push(mallAction);
            continue;
          }

          const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const logCheckpoint = await createLogCheckpoint();
          let result: ScheduleCommandOutput;

          if (taskConfig) {
            result = await executeDynamicTask(params, taskConfig, task.name, null, true);
          } else {
            const args = params ? params.split(' ').filter(arg => arg) : [];
            result = await executeCommand(command, args, task.name, null, true);
          }

          if (result?.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) taskSummaries.push(summary);
          }

          const mallAction = parseMallExecutionAction(
            task.name,
            task.params,
            await readLogSince(logCheckpoint)
          );
          actionResults.push(mallAction);

          if (mallAction.status === 'failed') {
            failedCount++;
            errors.push({ task: task.name, error: mallAction.message });
          } else if (mallAction.status === 'skipped') {
            skippedCount++;
            skipped.push({ task: task.name, reason: mallAction.message });
          } else {
            successCount++;
          }

          const delayCompleted = await waitForDelay(2000);
          if (!delayCompleted) break;
          continue;
        } catch (error) {
          if (executionStatus.shouldStop) break;
          failedCount++;
          errors.push({ task: task.name, error: errorMessageOf(error) });
          actionResults.push({
            task: task.name,
            action: 'mall',
            status: 'failed',
            message: `信用收支失败：${errorMessageOf(error)}`
          });
          logger.error('信用收支执行失败', { scheduleId, taskName: task.name, error: errorMessageOf(error) });
          continue;
        }
      }

      try {
        const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);

        if (taskConfig) {
          const taskId = params;
          // 定时任务需要等待命令完成才能获取输出
          const result = await executeDynamicTask(taskId, taskConfig, task.name, null, true);

          // 尝试从输出中提取任务总结
          if (result.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) {
              taskSummaries.push(summary);
            }
          }
        } else {
          const args = params ? params.split(' ').filter(arg => arg) : [];

          // 如果是 fight 命令，处理多个关卡
          if (command === 'fight' && args.length > 0) {
            const stageInput = args[0];
            const clientType = task.params.clientType || DEFAULT_CLIENT_TYPE;
            // 关卡开放按连接 profile 的客户端游戏日判定；任务显式指定的类型优先。
            const gameClientType = task.params.clientType || sharedConnection.clientType || DEFAULT_CLIENT_TYPE;

            // 解析关卡列表，格式：stage1:times1,stage2:times2 或 stage1,stage2
            const stageEntries = stageInput.split(',').map(s => {
              const parts = s.trim().split(':');
              return {
                stage: parts[0],
                times: parts[1] || ''
              };
            }).filter(s => s.stage);

            if (stageEntries.length > 1) {
              // 多个关卡，依次执行
              logger.info('检测到多个关卡', {
                scheduleId,
                stages: stageEntries.map(e => `${e.stage}${e.times ? `:${e.times}` : ''}`).join(', ')
              });

              let sanityDepleted = false;
              const fightActionStartIndex = fightActions.length;

              for (let i = 0; i < stageEntries.length; i++) {
                if (executionStatus.shouldStop || abortController.signal.aborted) {
                  logger.warn('多关卡任务收到停止信号，不再进入下一关', { scheduleId });
                  break;
                }
                const { stage, times } = stageEntries[i];

                // 如果理智已耗尽，跳过剩余关卡
                if (sanityDepleted) {
                  logger.info('理智已耗尽，跳过关卡', { scheduleId, stage });
                  addFightAction(createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    skipReason: '理智已耗尽'
                  }));
                  continue;
                }

                // 检查关卡是否开放（资源收集全开放窗口由端口按客户端类型解析）
                const openCheck = await isStageOpenToday(stage, gameClientType);
                if (!openCheck.isOpen) {
                  logger.info('关卡今日未开放，跳过', {
                    scheduleId,
                    stage,
                    reason: openCheck.reason
                  });
                  addFightAction(createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    skipReason: openCheck.reason
                  }));
                  continue; // 跳过这个关卡
                }

                logger.info('执行关卡', {
                  scheduleId,
                  stageIndex: i + 1,
                  totalStages: stageEntries.length,
                  stage,
                  times
                });

                // 替换活动代号
                const realStage = await replaceActivityCode(stage, clientType);
                if (realStage !== stage) {
                  logger.debug('关卡代号已替换', {
                    scheduleId,
                    originalStage: stage,
                    realStage
                  });
                }

                // 构建当前关卡的参数（移除第一个参数，添加当前关卡和次数）
                const currentArgs: string[] = [realStage];
                if (times) {
                  currentArgs.push('--times', times);
                }

                // 添加其他参数（理智药、源石、连战倍率等）。
                // 次数是该关卡的累计作战局数上限，连战倍率是每局代理的重复次数；
                // 两者同时下发，由 MaaCore 按剩余次数裁决，不在本地丢弃用户选择。
                currentArgs.push(...args.slice(1));

                // 执行命令
                try {
                  const result = await executeCommand(command, currentArgs, `${task.name} (${stage})`, null, true);
                  if (executionStatus.shouldStop || abortController.signal.aborted) break;
                  const reportSummary = getFightReportResults(task, stage, result);
                  reportResults.push(...reportSummary.reportResults);
                  reportSummary.diagnostics.forEach(diagnostic => executionWarnings.add(diagnostic.message));

                  // 检查理智状态（传入关卡名称用于排除剿灭）
                  const output = (result.stdout || '') + (result.stderr || '');
                  logger.debug('检查理智状态', {
                    scheduleId,
                    stage,
                    outputLength: output.length
                  });
                  logger.debug('输出内容预览', {
                    scheduleId,
                    preview: output.substring(0, 200)
                  });

                  if (isFightSanityDepleted(output, stage)) {
                    logger.info('检测到理智已耗尽', { scheduleId, stage });
                    sanityDepleted = true;
                  } else {
                    logger.debug('未检测到理智耗尽', { scheduleId, stage });
                  }

                  // 提取任务总结
                  const summary = result.stdout
                    ? parseTaskSummary(`${task.name} (${stage})`, result.stdout, logger)
                    : null;
                  if (summary) {
                    taskSummaries.push(summary);
                    await recordFightDrops(summary, scheduleId);
                  }
                  addFightAction(createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    summary,
                    output
                  }));
                } catch (error) {
                  if (executionStatus.shouldStop || abortController.signal.aborted) {
                    logger.warn('当前关卡已被终止，不再执行后续关卡', { scheduleId, stage });
                    break;
                  }
                  const errorMsg = errorMessageOf(error);
                  const errorOutput = errorOutputOf(error);

                  logger.debug('任务执行出错，检查是否理智不足', {
                    scheduleId,
                    stage,
                    errorMsg
                  });

                  const fightAction = createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    output: errorOutput,
                    error
                  });
                  if (fightAction.sanityDepleted) {
                    logger.info('检测到理智已耗尽（从错误信息）', { scheduleId, stage });
                    sanityDepleted = true;
                  } else if (fightAction.status === 'skipped') {
                    logger.info('关卡未执行，已跳过', { scheduleId, stage, reason: fightAction.message });
                  } else {
                    logger.error('关卡执行失败', { scheduleId, stage, error: errorMsg });
                  }
                  addFightAction(fightAction);
                }

                // 关卡之间等待2秒
                if (i < stageEntries.length - 1) {
                  logger.debug('等待后继续下一个关卡', { scheduleId, waitSeconds: 2 });
                  const delayCompleted = await waitForDelay(2000);
                  if (!delayCompleted) break;
                }
              }

              countFightTaskResult(fightActions.slice(fightActionStartIndex));

              // 所有关卡完成后的延迟
              const delayTime = 2000;
              logger.debug('任务完成，等待后继续', {
                scheduleId,
                taskName: task.name,
                delaySeconds: delayTime / 1000
              });
              const delayCompleted = await waitForDelay(delayTime);
              if (!delayCompleted) break;

              continue; // 跳过后面的单关卡处理
            } else {
              // 单个关卡，检查是否开放
              const { stage, times } = stageEntries[0];

              // 检查关卡是否开放
              const openCheck = await isStageOpenToday(stage, gameClientType);
              if (!openCheck.isOpen) {
                logger.info('关卡今日未开放，跳过', {
                  scheduleId,
                  stage,
                  reason: openCheck.reason
                });
                const fightAction = createFightExecutionAction(`${task.name} (${stage})`, stage, {
                  skipReason: openCheck.reason
                });
                addFightAction(fightAction);
                countFightTaskResult([fightAction]);

                // 跳过后的延迟
                logger.debug('任务已跳过，等待后继续', {
                  scheduleId,
                  taskName: task.name,
                  waitSeconds: 2
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue; // 跳过这个任务
              }

              // 替换活动代号
              const realStage = await replaceActivityCode(stage, clientType);
              if (realStage !== stage) {
                args[0] = realStage; // 只保留关卡名，不要拼接次数
                logger.debug('关卡代号已替换', {
                  scheduleId,
                  originalStage: stage,
                  realStage
                });
              } else if (times) {
                // 如果没有替换但有次数，也要更新 args[0] 为纯关卡名
                args[0] = stage;
              }

              // 有次数时补 --times；次数是累计作战局数上限，连战倍率保留，
              // 由 MaaCore 按剩余次数裁决。
              if (times && !args.includes('--times')) {
                args.splice(1, 0, '--times', times);
              }
            }
          }

          // 定时任务需要等待命令完成才能获取输出
          const result = await executeCommand(command, args, task.name, null, true);
          if (command === 'closedown') {
            actionResults.push({
              task: task.name,
              action: 'closedown',
              status: 'success',
              message: '游戏客户端已关闭'
            });
          }
          const fightStage = command === 'fight' ? (args[0] || task.params?.stage || '') : '';
          if (command === 'fight') {
            const stage = fightStage;
            const reportSummary = getFightReportResults(task, stage, result);
            reportResults.push(...reportSummary.reportResults);
            reportSummary.diagnostics.forEach(diagnostic => executionWarnings.add(diagnostic.message));
          }

          // 尝试从输出中提取任务总结
          let parsedTaskSummary: FlowTaskSummary | null = null;
          if (result.stdout) {
            parsedTaskSummary = parseTaskSummary(task.name, result.stdout, logger);
            if (parsedTaskSummary) {
              taskSummaries.push(parsedTaskSummary);
              if (command === 'fight') await recordFightDrops(parsedTaskSummary, scheduleId);
            }
          }

          if (command === 'fight') {
            const output = (result.stdout || '') + (result.stderr || '');
            const fightAction = createFightExecutionAction(task.name, fightStage, {
              summary: parsedTaskSummary,
              output
            });
            addFightAction(fightAction);
            countFightTaskResult([fightAction]);
          }
        }

        if (commandId !== 'fight') successCount++;

        // 任务完成后的延迟时间
        // 启动游戏需要更长的等待时间，确保游戏完全启动
        let delayTime = 2000;
        if (commandId === 'startup') {
          delayTime = 15000; // 启动游戏等待15秒
        } else if (commandId === 'closedown') {
          delayTime = 3000; // 关闭游戏等待3秒
        }

        logger.debug('任务完成，等待后继续', {
          scheduleId,
          taskName: task.name,
          delaySeconds: delayTime / 1000
        });
        const delayCompleted = await waitForDelay(delayTime);
        if (!delayCompleted) {
          logger.warn('任务间等待已被终止信号打断', { scheduleId, taskName: task.name });
          break;
        }
      } catch (error) {
        if (executionStatus.shouldStop) {
          logger.warn('当前任务已被用户终止', { scheduleId, taskName: task.name });
          break;
        }

        failedCount++;
        errors.push({ task: task.name, error: errorMessageOf(error) });
        if (commandId === 'fight') {
          const configuredStage = configuredStageOf(task.params);
          const action = createFightExecutionAction(task.name, configuredStage, { error });
          actionResults.push(action);
          if (action.status === 'skipped') {
            failedCount--;
            errors.pop();
            skippedCount++;
            skipped.push({ task: action.task, reason: action.message });
          }
        }
        if (commandId === 'closedown') {
          actionResults.push({
            task: task.name,
            action: 'closedown',
            status: 'failed',
            message: `关闭游戏失败：${errorMessageOf(error)}`
          });
        }
        logger.error('任务执行失败', {
          scheduleId,
          taskName: task.name,
          error: errorMessageOf(error)
        });
        // 继续执行下一个任务
      }
    }

    taskProgress.finish({ stopped: executionStatus.shouldStop });
    const duration = Date.now() - startTime;
    const wasStopped = executionStatus.shouldStop;
    const { completionMessage, executionSummary } = buildFlowExecutionOutcome({
      successCount,
      failedCount,
      skippedCount,
      durationMs: duration,
      wasStopped,
      summaries: taskSummaries,
      reports: reportResults,
      actions: actionResults,
      errors,
      warnings: [...executionWarnings],
      taskResults: taskProgress.results
    });
    logger.info(completionMessage, {
      scheduleId,
      successCount,
      failedCount,
      skippedCount,
      durationSeconds: Math.floor(duration / 1000)
    });

    // 更新状态：完成
    updateStatus({
      isRunning: false,
      currentStep: wasStopped ? executionStatus.currentStep : enabledTasks.length,
      message: completionMessage,
      scheduleId: null,
      runId: null,
      currentTask: null,
      currentTaskId: null,
      shouldStop: false,
      lastResult: executionSummary
    });
    activeAbortController = null;
    activeExecutionToken = null;

    if (wasStopped) {
      return { success: true, stopped: true, message: completionMessage, summary: executionSummary };
    }

    // 动态更新智能养成关卡（存储适配经由端口）
    try {
      await refreshSmartTrainingStages(scheduleId);
    } catch (error) {
      logger.error('动态更新智能养成关卡失败', {
        scheduleId,
        error: errorMessageOf(error)
      });
    }

    // 发送完成通知（通知适配经由端口）
    try {
      await sendCompletionNotification({
        taskName: `定时任务 ${scheduleId}`,
        totalTasks: enabledTasks.length,
        successTasks: successCount,
        failedTasks: failedCount,
        skippedTasks: skippedCount,
        duration,
        errors,
        skipped,
        summaries: taskSummaries,
        actions: actionResults,
        reports: reportResults,
        warnings: [...executionWarnings],
        screenshot,
      });
    } catch (error) {
      logger.error('发送通知失败', {
        scheduleId,
        error: errorMessageOf(error)
      });
    }

    return { success: true, stopped: false, message: completionMessage, summary: executionSummary };
  }

  async function executeTaskFlow(
    taskFlow: unknown,
    scheduleId: string,
    lifecycle: ScheduleFlowLifecycle = {},
    options: ScheduleFlowExecutionOptions = {}
  ): Promise<ScheduleFlowExecutionResult> {
    const executionToken = Symbol(scheduleId);
    const runId = typeof options.runId === 'string' && options.runId.trim() ? options.runId : null;
    let unexpectedError: unknown = null;
    try {
      return await withExecutionLease({
        source: 'schedule',
        taskName: `任务流程 ${scheduleId}`,
        command: 'schedule'
      }, () => runTaskFlow(taskFlow, scheduleId, executionToken, lifecycle, runId));
    } catch (error) {
      if (errorFieldOf(error, 'code') === 'MAA_EXECUTION_BUSY') {
        logger.warn('设备正被其他 MAA 任务占用，跳过任务流程', {
          scheduleId,
          owner: errorFieldOf(error, 'owner')
        });
        return {
          success: false,
          message: errorMessageOf(error),
          busy: true,
          owner: errorFieldOf(error, 'owner')
        };
      }
      if (errorFieldOf(error, 'stopped')) {
        updateStatus({ shouldStop: true });
      } else {
        unexpectedError = error;
      }
      throw error;
    } finally {
      const ownsActiveExecution = activeExecutionToken === executionToken;
      if (ownsActiveExecution) {
        activeTaskProgress?.finish({ stopped: executionStatus.shouldStop });
      }
      if (ownsActiveExecution && executionStatus.isRunning) {
        const wasStopped = executionStatus.shouldStop;
        const message = wasStopped
          ? '任务流程已被用户终止'
          : `任务流程异常终止${unexpectedError ? `: ${errorMessageOf(unexpectedError)}` : ''}`;

        logger.error('任务流程未正常收尾，已复位执行状态', {
          scheduleId,
          runId,
          stopped: wasStopped,
          error: unexpectedError ? errorMessageOf(unexpectedError) : null
        });
        updateStatus({
          isRunning: false,
          scheduleId: null,
          runId: null,
          currentStep: -1,
          totalSteps: 0,
          currentTask: null,
          currentTaskId: null,
          message,
          startTime: null,
          shouldStop: false
        });
      }

      if (ownsActiveExecution || !executionStatus.isRunning) {
        cancelActiveDelay = null;
        activeAbortController = null;
        activeTaskProgress = null;
        if (ownsActiveExecution) activeExecutionToken = null;
      }
    }
  }

  return {
    execute: executeTaskFlow,
    getStatus,
    stop
  };
}
