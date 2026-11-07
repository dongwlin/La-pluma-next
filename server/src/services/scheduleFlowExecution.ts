import { createScheduleTaskProgress } from './scheduleTaskProgress.ts';
import type { ScheduleTaskProgress, ScheduleTaskProgressResult } from './scheduleTaskProgress.ts';
import { buildScheduledTaskCommand, validateScheduledTaskFlow } from './scheduleFlowPlan.ts';
import type { ScheduledTask, ScheduledTaskParams } from './scheduleFlowPlan.ts';
import {
  buildFlowExecutionOutcome,
  getFightReportResults,
  parseFightStatistics,
  parseTaskSummary,
  reconcileTruncatedFightStatistics
} from './scheduleFlowResult.ts';
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
import { parseGameTaskExecutionAction, readOperProgressPlans } from './gameTaskResultService.ts';
import type { GameTaskExecutionAction } from './gameTaskResultService.ts';
import type { FightExecutionAction, FightStructuredStatistics } from './fightResultService.ts';
import type { MaaLogCheckpoint, MaaLogIncrement } from './maaLogFileService.ts';
import type { MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import type { DropRecordInput } from './dropRecordService.ts';
import type { StageOpenState, TaskCompletionInfo } from './notificationService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { createLogger } from '../utils/logger.ts';

/**
 * 流程执行器：步骤结论用 `success`/`failed`/`skipped` 有穷联合，终止时进度记 `stopped`
 * 而非失败；日志只读检查点之后的新增内容；设备命令、通知、掉落与养成回写全部经端口注入，
 * 同一进程只创建一个实例。
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

export interface ScheduleCommandOutput {
  stdout: string;
  stderr: string;
  actions?: GameTaskExecutionAction[];
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

export type ScheduleDepotParseResult =
  | { success: true; data: { itemCount: number } }
  | { success: false };

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
    waitForCompletion: boolean,
    clientType?: string
  ): Promise<ScheduleCommandOutput>;
  createLogCheckpoint(): Promise<MaaLogCheckpoint | null>;
  readLogSince(checkpoint: MaaLogCheckpoint | null): Promise<MaaLogIncrement>;
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

/** 完成通知载荷：只由调度入口在租约释放后消费，不进入 Run 或 HTTP 结果。 */
export interface ScheduleFlowCompletion extends TaskCompletionInfo {
  scheduleId: string;
}

/** 完成副作用结果：错误显式返回，调用方记录后不得伪装成执行失败。 */
export interface ScheduleFlowCompletionResult {
  performed: boolean;
  errors: string[];
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
  /** 在调用方释放租约并结算 Run 之后执行通知与养成回写；每个结果只消费一次。 */
  dispatchCompletion(result: ScheduleFlowExecutionResult): Promise<ScheduleFlowCompletionResult>;
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

function errorOutputOf(error: unknown): string {
  return String(errorFieldOf(error, 'stdout') || '') + String(errorFieldOf(error, 'stderr') || '');
}

function configuredStageOf(params: ScheduledTaskParams | undefined): string {
  const first = params?.stages?.[0];
  const stage = first && typeof first === 'object' ? first.stage : undefined;
  return String(stage || params?.stage || '');
}

function explicitClientTypeOf(value: unknown): string | undefined {
  const clientType = typeof value === 'string' ? value.trim() : '';
  return clientType || undefined;
}

/**
 * 从检查点增量日志解析 fight 统计：增量被截断（只拿到尾部）时，逐批累加的
 * 理智与每局增量掉落不再是整次执行的总量，统计层只保留累计证据，再用可核对的
 * 完整 CLI 摘要修正局数与掉落；增量完整时维持既有解析结果。
 */
function parseFlowFightStatistics(
  logIncrement: MaaLogIncrement,
  summary: FlowTaskSummary | null,
  fallbackStage: string
): FightStructuredStatistics | null {
  const logComplete = logIncrement.status === 'ok';
  const statistics = parseFightStatistics(logIncrement.text, fallbackStage, { logComplete });
  if (!statistics || logComplete) return statistics;
  return reconcileTruncatedFightStatistics(statistics, summary);
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
  const completionByResult = new WeakMap<object, ScheduleFlowCompletion>();

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

  function getStatus(): ScheduleExecutionStatus {
    return { ...executionStatus };
  }

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

  function updateStatus(updates: Partial<ScheduleExecutionStatus>) {
    Object.assign(executionStatus, updates);
    logger.debug('定时任务状态更新', executionStatus);
  }

  async function recordFightDrops(
    statistics: FightStructuredStatistics | null,
    summary: FlowTaskSummary | null,
    scheduleId: string,
    recordKey: string,
    fallbackStage = ''
  ) {
    const stage = statistics?.stage || String(summary?.stage || '').trim() || fallbackStage;
    let input: DropRecordInput | null = null;

    if (stage && statistics && (statistics.observed.stageDrops || statistics.observed.fightTimes)) {
      input = {
        stage,
        times: statistics.battles,
        items: statistics.drops,
        medicine: Math.max(0, Number(summary?.medicine) || 0),
        stone: Math.max(0, Number(summary?.stone) || 0),
        recordKey,
        ...(statistics.sanity === undefined ? {} : { sanity: statistics.sanity }),
        ...(statistics.sanityBeforeStage === undefined ? {} : { sanityBefore: statistics.sanityBeforeStage }),
        ...(statistics.maxSanity === undefined ? {} : { maxSanity: statistics.maxSanity })
      };
    } else {
      const summaryStage = String(summary?.stage || '').trim();
      const summaryItems = summary && Array.isArray(summary.dropItems) ? summary.dropItems : [];
      if (summaryStage && summaryItems.length > 0) {
        const times = Math.max(1, Number(summary?.times) || 1);
        input = {
          stage: summaryStage,
          times,
          items: summaryItems,
          medicine: Math.max(0, Number(summary?.medicine) || 0),
          stone: Math.max(0, Number(summary?.stone) || 0),
          recordKey
        };
      }
    }

    if (!input) {
      logger.warn('未能获取战斗掉落信息，跳过掉落记录', { scheduleId, stage });
      return;
    }

    try {
      await recordDrops(input);
      logger.debug('掉落记录已保存', {
        scheduleId,
        stage: input.stage,
        times: input.times,
        sanity: input.sanity
      });
    } catch (error) {
      logger.error('掉落记录保存失败', { scheduleId, error: errorMessageOf(error) });
    }
  }

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
      shouldStop: false,
      lastResult: null,
      taskResults: []
    });

    // The pre-start gate runs after the flow owns the lease and the scheduler
    // status is live, so a concurrent stop either aborts here or sets shouldStop.
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();

    const startTime = Date.now();
    const executionRecordKey = `${scheduleId}:${runId || startTime}`;
    const enabledTasks = tasks.filter(t => t.enabled);
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const errors: FlowTaskError[] = [];
    const skipped: FlowTaskSkip[] = [];
    const taskSummaries: FlowTaskSummary[] = [];
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

      updateStatus({
        currentStep: i,
        currentTask: task.name,
        currentTaskId: task.id,
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
            (await readLogSince(logCheckpoint)).text
          );
          actionResults.push(...awardActions);
          const failedAwardActions = awardActions.filter(action => action.status === 'failed');
          if (failedAwardActions.length > 0) {
            failedCount++;
            for (const action of failedAwardActions) {
              errors.push({ task: task.name, error: action.message });
            }
          } else if (awardActions.some(action => action.status === 'success')) {
            successCount++;
          } else {
            skippedCount++;
            skipped.push({ task: task.name, reason: awardActions[0].message });
          }

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

      if (commandId === 'closedown' && task.params?.recognizeDepotBeforeClose === true) {
        try {
          logger.info('关闭游戏前先识别仓库', { scheduleId });

          // 等待3秒确保游戏回到主界面
          logger.debug('等待游戏回到主界面', { scheduleId, waitSeconds: 3 });
          if (!(await waitForDelay(3000))) break;

          updateStatus({
            message: '正在识别仓库...'
          });

          const depotTaskConfig = {
            name: '仓库识别',
            type: 'Depot',
            params: {
              enable: true
            }
          };

          try {
            await executeDynamicTask('Depot_temp', JSON.stringify(depotTaskConfig), '仓库识别', 'depot', true);
            logger.success('仓库识别命令执行完成', { scheduleId });

            logger.debug('开始解析仓库数据', { scheduleId });
            const parseResult = await parseDepotData();
            if (parseResult?.success) {
              const { itemCount } = parseResult.data;
              logger.success('仓库数据已保存', {
                scheduleId,
                itemCount
              });
              actionResults.push({
                task: task.name,
                action: 'depot',
                status: 'success',
                message: `关闭前仓库识别完成，共 ${itemCount} 项`
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

          logger.debug('等待后继续', { scheduleId, waitSeconds: 2 });
          if (!(await waitForDelay(2000))) break;
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
              // 重试前等待3秒；停止信号必须在重试之间生效。
              if (!(await waitForDelay(3000))) break;
            }

            const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
            const startupClientType = explicitClientTypeOf(task.params.clientType);
            if (taskConfig) {
              await executeDynamicTask(params, taskConfig, task.name, null, true, startupClientType);
            } else {
              const args = params ? params.split(' ').filter(arg => arg) : [];
              await executeCommand(command, args, task.name, null, true);
            }

            logger.info('启动游戏命令执行完成', { scheduleId });

            // 同时检查前台包名和截图，避免游戏闪退到模拟器桌面后被误判为成功。
            try {
              logger.debug('检测游戏是否运行中', { scheduleId });
              const gameState = await getGameClientState(
                adbConfig.adbPath,
                adbConfig.address,
                startupClientType || sharedConnection.clientType || DEFAULT_CLIENT_TYPE
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
                message: task.params.start_game_enabled === false
                  ? task.params.accountName
                    ? `已进入游戏主界面，账号 ${task.params.accountName} 已匹配`
                    : '已连接运行中的游戏并进入主界面'
                  : task.params.accountName
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
            (await readLogSince(logCheckpoint)).text
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
            (await readLogSince(logCheckpoint)).text
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
            (await readLogSince(logCheckpoint)).text
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

      if (task.taskType === 'OperProgress' || task.taskType === 'SwitchTheme') {
        let action: GameTaskExecutionAction;
        try {
          const { params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const result = await executeDynamicTask(params, taskConfig || '', task.name, null, true);
          if (executionStatus.shouldStop) break;
          action = result.actions?.[0]
            || parseGameTaskExecutionAction(task.name, task.taskType, '', readOperProgressPlans(task.params));
        } catch (error) {
          if (executionStatus.shouldStop) break;
          const fields = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
          const details = typeof fields.details === 'object' && fields.details !== null
            ? fields.details as Record<string, unknown>
            : {};
          const observed = Array.isArray(details.actions) ? details.actions[0] as GameTaskExecutionAction | undefined : undefined;
          action = {
            ...(observed
              || parseGameTaskExecutionAction(task.name, task.taskType, '', readOperProgressPlans(task.params))),
            status: 'failed',
            message: observed?.status === 'failed' ? observed.message : errorMessageOf(error)
          };
        }
        actionResults.push(action);
        if (action.status === 'failed') {
          failedCount++;
          errors.push({ task: task.name, error: action.message });
        } else if (action.status === 'skipped') {
          skippedCount++;
          skipped.push({ task: task.name, reason: action.message });
        } else {
          successCount++;
          if (!action.observed) executionWarnings.add(action.message);
        }
        if (!await waitForDelay(2000)) break;
        continue;
      }

      try {
        const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);

        if (taskConfig) {
          const taskId = params;
          // 定时任务需要等待命令完成才能获取输出
          const result = await executeDynamicTask(taskId, taskConfig, task.name, null, true);

          if (result.stdout) {
            const summary = parseTaskSummary(task.name, result.stdout, logger);
            if (summary) {
              taskSummaries.push(summary);
            }
          }
        } else {
          const args = params ? params.split(' ').filter(arg => arg) : [];

          if (command === 'fight' && args.length > 0) {
            const stageInput = args[0];
            const clientType = task.params.clientType || DEFAULT_CLIENT_TYPE;
            // 关卡开放按连接 profile 的客户端游戏日判定；任务显式指定的类型优先。
            const gameClientType = task.params.clientType || sharedConnection.clientType || DEFAULT_CLIENT_TYPE;

            const stageEntries = stageInput.split(',').map(s => {
              const parts = s.trim().split(':');
              return {
                stage: parts[0],
                times: parts[1] || ''
              };
            }).filter(s => s.stage);

            if (stageEntries.length > 1) {
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

                if (sanityDepleted) {
                  logger.info('理智已耗尽，跳过关卡', { scheduleId, stage });
                  addFightAction(createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    skipReason: '理智已耗尽'
                  }));
                  continue;
                }

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
                  continue;
                }

                logger.info('执行关卡', {
                  scheduleId,
                  stageIndex: i + 1,
                  totalStages: stageEntries.length,
                  stage,
                  times
                });

                const realStage = await replaceActivityCode(stage, clientType);
                if (realStage !== stage) {
                  logger.debug('关卡代号已替换', {
                    scheduleId,
                    originalStage: stage,
                    realStage
                  });
                }

                const currentArgs: string[] = [realStage];
                if (times) {
                  currentArgs.push('--times', times);
                }

                // 次数是累计作战局数上限，连战倍率是每局代理的重复次数；两者同时下发，
                // 由 MaaCore 按剩余次数裁决，不在本地丢弃用户选择。
                currentArgs.push(...args.slice(1));

                try {
                  const logCheckpoint = await createLogCheckpoint();
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

                  const summary = result.stdout
                    ? parseTaskSummary(`${task.name} (${stage})`, result.stdout, logger)
                    : null;
                  if (summary) taskSummaries.push(summary);
                  const fightStatistics = parseFlowFightStatistics(
                    await readLogSince(logCheckpoint),
                    summary,
                    stage
                  );
                  await recordFightDrops(
                    fightStatistics,
                    summary,
                    scheduleId,
                    `${executionRecordKey}:${task.id}:${stage}:${i}`,
                    stage
                  );
                  addFightAction(createFightExecutionAction(`${task.name} (${stage})`, stage, {
                    summary,
                    output,
                    statistics: fightStatistics
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

                if (i < stageEntries.length - 1) {
                  logger.debug('等待后继续下一个关卡', { scheduleId, waitSeconds: 2 });
                  const delayCompleted = await waitForDelay(2000);
                  if (!delayCompleted) break;
                }
              }

              countFightTaskResult(fightActions.slice(fightActionStartIndex));

              const delayTime = 2000;
              logger.debug('任务完成，等待后继续', {
                scheduleId,
                taskName: task.name,
                delaySeconds: delayTime / 1000
              });
              const delayCompleted = await waitForDelay(delayTime);
              if (!delayCompleted) break;

              continue;
            } else {
              const { stage, times } = stageEntries[0];

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

                logger.debug('任务已跳过，等待后继续', {
                  scheduleId,
                  taskName: task.name,
                  waitSeconds: 2
                });
                if (!(await waitForDelay(2000))) break;
                continue;
              }

              const realStage = await replaceActivityCode(stage, clientType);
              if (realStage !== stage) {
                args[0] = realStage;
                logger.debug('关卡代号已替换', {
                  scheduleId,
                  originalStage: stage,
                  realStage
                });
              } else if (times) {
                args[0] = stage;
              }

              if (times && !args.includes('--times')) {
                args.splice(1, 0, '--times', times);
              }
            }
          }

          const fightLogCheckpoint = command === 'fight' ? await createLogCheckpoint() : null;
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

          let parsedTaskSummary: FlowTaskSummary | null = null;
          if (result.stdout) {
            parsedTaskSummary = parseTaskSummary(task.name, result.stdout, logger);
            if (parsedTaskSummary) taskSummaries.push(parsedTaskSummary);
          }

          if (command === 'fight') {
            const fightStatistics = parseFlowFightStatistics(
              await readLogSince(fightLogCheckpoint),
              parsedTaskSummary,
              fightStage
            );
            await recordFightDrops(
              fightStatistics,
              parsedTaskSummary,
              scheduleId,
              `${executionRecordKey}:${task.id}:${fightStage}:0`,
              fightStage
            );
            const output = (result.stdout || '') + (result.stderr || '');
            const fightAction = createFightExecutionAction(task.name, fightStage, {
              summary: parsedTaskSummary,
              output,
              statistics: fightStatistics
            });
            addFightAction(fightAction);
            countFightTaskResult([fightAction]);
          }
        }

        if (commandId !== 'fight') successCount++;

        // 启动游戏需要更长的等待时间，确保游戏完全启动
        let delayTime = 2000;
        if (commandId === 'startup') {
          delayTime = 15000;
        } else if (commandId === 'closedown') {
          delayTime = 3000;
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

    const completed: ScheduleFlowCompletedResult = {
      success: true,
      stopped: false,
      message: completionMessage,
      summary: executionSummary
    };
    // 通知与智能养成回写不属于执行本身：流程持有租约期间只准备载荷，
    // 由调度入口在设备释放、Run 结算并落盘之后调用 dispatchCompletion。
    completionByResult.set(completed, {
      scheduleId,
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
      screenshot
    });
    return completed;
  }

  async function dispatchCompletion(
    result: ScheduleFlowExecutionResult
  ): Promise<ScheduleFlowCompletionResult> {
    if (!result.success || result.stopped) return { performed: false, errors: [] };
    const completion = completionByResult.get(result);
    if (!completion) return { performed: false, errors: [] };
    completionByResult.delete(result);

    const errors: string[] = [];
    try {
      await refreshSmartTrainingStages(completion.scheduleId);
    } catch (error) {
      const message = errorMessageOf(error);
      errors.push(`动态更新智能养成关卡失败: ${message}`);
      logger.error('动态更新智能养成关卡失败', {
        scheduleId: completion.scheduleId,
        error: message
      });
    }

    try {
      await sendCompletionNotification(completion);
    } catch (error) {
      const message = errorMessageOf(error);
      errors.push(`发送通知失败: ${message}`);
      logger.error('发送通知失败', {
        scheduleId: completion.scheduleId,
        error: message
      });
    }
    return { performed: true, errors };
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
    stop,
    dispatchCompletion
  };
}
