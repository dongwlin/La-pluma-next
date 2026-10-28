import { createScheduleTaskProgress } from './scheduleTaskProgress.js';
import { buildScheduledTaskCommand, validateScheduledTaskFlow } from './scheduleFlowPlan.js';
import { buildFlowExecutionOutcome, getFightReportResults, parseTaskSummary } from './scheduleFlowResult.js';
import { getEnabledAwardItems, parseAwardExecutionActions } from './awardResultService.ts';
import { parseRecruitExecutionAction } from './recruitResultService.ts';
import { parseInfrastExecutionAction } from './infrastResultService.ts';
import { parseMallExecutionAction } from './mallResultService.ts';
import { createFightExecutionAction, isFightSanityDepleted } from './fightResultService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.js';
import { createLogger } from '../utils/logger.ts';

const REQUIRED_PORTS = [
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

/**
 * 创建流程执行器。每个实例独占一份执行状态、停止信号和任务进度，
 * 同一进程只应在组装处创建一个实例，保证异步流程只有一个执行所有者。
 *
 * 设备命令、日志检查点、通知发送、掉落记录与智能养成回写全部通过 ports 注入；
 * 执行规则本身不直接读写设备、用户配置或通知实现。
 */
export function createScheduleFlowExecutor({ ports, logger = createLogger('Scheduler') } = {}) {
  for (const name of REQUIRED_PORTS) {
    if (typeof ports?.[name] !== 'function') {
      throw new TypeError(`createScheduleFlowExecutor 缺少执行端口: ${name}`);
    }
  }

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
  } = ports;

  // 定时任务执行状态
  const executionStatus = {
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

  let cancelActiveDelay = null;
  let activeAbortController = null;
  let activeExecutionToken = null;
  let activeTaskProgress = null;

  function waitForDelay(delayMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const signal = activeAbortController?.signal;

      const finish = (completed) => {
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
  function getStatus() {
    return { ...executionStatus };
  }

  /**
   * 停止当前正在执行的任务流程
   */
  function stop() {
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
  function updateStatus(updates) {
    Object.assign(executionStatus, updates);
    logger.debug('定时任务状态更新', executionStatus);
  }

  async function recordFightDrops(summary, scheduleId) {
    if (!summary?.stage || !Array.isArray(summary.dropItems) || summary.dropItems.length === 0) return;

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
      logger.error('掉落记录保存失败', { scheduleId, error: error.message });
    }
  }

  // 执行任务流程
  async function runTaskFlow(taskFlow, scheduleId, executionToken, lifecycle = {}, runId = null) {
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

    logger.info('开始执行任务流程', { scheduleId, runId });
    activeExecutionToken = executionToken;
    activeAbortController = new AbortController();

    // 更新状态：开始执行
    updateStatus({
      isRunning: true,
      scheduleId,
      runId,
      currentStep: -1,
      totalSteps: taskFlow.filter(t => t.enabled).length,
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
    const enabledTasks = taskFlow.filter(t => t.enabled);
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const errors = [];
    const skipped = [];
    const taskSummaries = []; // 收集任务总结信息
    const reportResults = [];
    const executionWarnings = new Set();
    const actionResults = [];
    const addFightAction = (action) => {
      actionResults.push(action);
      if (action.status === 'failed') {
        errors.push({ task: action.task, error: action.message });
      } else if (action.status === 'skipped') {
        skipped.push({ task: action.task, reason: action.message });
      }
    };
    const countFightTaskResult = (actions) => {
      if (actions.some(action => action.status === 'failed')) failedCount++;
      else if (actions.some(action => action.status === 'success')) successCount++;
      else skippedCount++;
    };
    let screenshot = null;
    const taskProgress = createScheduleTaskProgress(
      enabledTasks,
      () => ({ successCount, failedCount, skippedCount }),
      taskResults => updateStatus({ taskResults })
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
          let result;

          if (taskConfig) {
            const taskId = params;
            result = await executeDynamicTask(taskId, taskConfig, task.name, null, true);
          } else {
            let args = params ? params.split(' ').filter(arg => arg) : [];
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
              logger.error('通知截图失败', { scheduleId, error: error.message });
            }
          }

          const delayCompleted = await waitForDelay(2000);
          if (!delayCompleted) break;
          continue;
        } catch (error) {
          failedCount++;
          errors.push({ task: task.name, error: error.message });
          actionResults.push({
            task: task.name,
            action: 'award',
            status: 'failed',
            message: `领取奖励失败：${error.message}`
          });
          logger.error('任务执行失败', {
            scheduleId,
            taskName: task.name,
            error: error.message
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
              error: depotError.message
            });
            actionResults.push({
              task: task.name,
              action: 'depot',
              status: 'failed',
              message: `关闭前仓库识别失败：${depotError.message}`
            });
            // 即使识别失败也继续执行后续任务
          }

          // 等待2秒
          logger.debug('等待后继续', { scheduleId, waitSeconds: 2 });
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          logger.error('仓库识别异常', {
            scheduleId,
            error: error.message
          });
          actionResults.push({
            task: task.name,
            action: 'depot',
            status: 'failed',
            message: `关闭前仓库识别异常：${error.message}`
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
            let args = params ? params.split(' ').filter(arg => arg) : [];
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
                error: error.message
              });
              retryCount++;
              if (retryCount > maxRetries) {
                throw new Error('游戏启动后闪退，已达到最大重试次数');
              }
            }
          } catch (error) {
            if (retryCount >= maxRetries) {
              failedCount++;
              errors.push({ task: task.name, error: error.message });
              actionResults.push({
                task: task.name,
                action: 'startup',
                status: 'failed',
                message: error.message
              });
              logger.error('任务执行失败', {
                scheduleId,
                taskName: task.name,
                error: error.message
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
          let result;

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
          errors.push({ task: task.name, error: error.message });
          actionResults.push({
            task: task.name,
            action: 'recruit',
            status: 'failed',
            message: `自动公招失败：${error.message}`
          });
          logger.error('自动公招执行失败', { scheduleId, taskName: task.name, error: error.message });
          continue;
        }
      }

      if (commandId === 'infrast') {
        try {
          if (!Array.isArray(task.params?.facility) || task.params.facility.length === 0) {
            const infrastAction = parseInfrastExecutionAction(task.name, task.params);
            skippedCount++;
            skipped.push({ task: task.name, reason: infrastAction.message });
            actionResults.push(infrastAction);
            continue;
          }

          const { command, params, taskConfig } = buildScheduledTaskCommand(task, adbConfig);
          const logCheckpoint = await createLogCheckpoint();
          let result;

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
          errors.push({ task: task.name, error: error.message });
          actionResults.push({
            task: task.name,
            action: 'infrast',
            status: 'failed',
            message: `基建任务失败：${error.message}`
          });
          logger.error('基建任务执行失败', { scheduleId, taskName: task.name, error: error.message });
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
          let result;

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
          errors.push({ task: task.name, error: error.message });
          actionResults.push({
            task: task.name,
            action: 'mall',
            status: 'failed',
            message: `信用收支失败：${error.message}`
          });
          logger.error('信用收支执行失败', { scheduleId, taskName: task.name, error: error.message });
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
          let args = params ? params.split(' ').filter(arg => arg) : [];

          // 如果是 fight 命令，处理多个关卡
          if (command === 'fight' && args.length > 0) {
            const stageInput = args[0];
            const clientType = task.params.clientType || DEFAULT_CLIENT_TYPE;

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
              const fightActionStartIndex = actionResults.length;

              for (let i = 0; i < stageEntries.length; i++) {
                if (executionStatus.shouldStop || activeAbortController.signal.aborted) {
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

                // 检查关卡是否开放
                const openCheck = isStageOpenToday(stage);
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
                const currentArgs = [realStage];
                if (times) {
                  currentArgs.push('--times', times);
                }

                // 添加其他参数（理智药、源石等）
                // 如果填了次数，排除 --series 参数；否则保留所有参数
                let otherArgs;
                if (times) {
                  // 填了次数，过滤掉 --series
                  otherArgs = args.slice(1).filter((arg, index, arr) => {
                    return arg !== '--series' && (index === 0 || arr[index - 1] !== '--series');
                  });
                } else {
                  // 没填次数，保留所有参数（包括 --series）
                  otherArgs = args.slice(1);
                }
                currentArgs.push(...otherArgs);

                // 执行命令
                try {
                  const result = await executeCommand(command, currentArgs, `${task.name} (${stage})`, null, true);
                  if (executionStatus.shouldStop || activeAbortController.signal.aborted) break;
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
                  if (executionStatus.shouldStop || activeAbortController.signal.aborted) {
                    logger.warn('当前关卡已被终止，不再执行后续关卡', { scheduleId, stage });
                    break;
                  }
                  const errorMsg = error.message || '';
                  const errorOutput = (error.stdout || '') + (error.stderr || '');

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

              countFightTaskResult(actionResults.slice(fightActionStartIndex));

              // 所有关卡完成后的延迟
              let delayTime = 2000;
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
              const openCheck = isStageOpenToday(stage);
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

              // 如果有次数，添加 --times 参数，并移除 --series 参数
              if (times && !args.includes('--times')) {
                args.splice(1, 0, '--times', times);

                // 移除 --series 参数（填了次数的关卡不使用连战）
                const seriesIndex = args.indexOf('--series');
                if (seriesIndex !== -1) {
                  args.splice(seriesIndex, 2); // 移除 --series 和它的值
                }
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
          let parsedTaskSummary = null;
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
        errors.push({ task: task.name, error: error.message });
        if (commandId === 'fight') {
          const configuredStage = task.params?.stages?.[0]?.stage || task.params?.stage || '';
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
            message: `关闭游戏失败：${error.message}`
          });
        }
        logger.error('任务执行失败', {
          scheduleId,
          taskName: task.name,
          error: error.message
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
        error: error.message
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
        error: error.message
      });
    }

    return { success: true, stopped: false, message: completionMessage, summary: executionSummary };
  }

  async function executeTaskFlow(taskFlow, scheduleId, lifecycle = {}, options = {}) {
    const executionToken = Symbol(scheduleId);
    const runId = typeof options.runId === 'string' && options.runId.trim() ? options.runId : null;
    let unexpectedError = null;
    try {
      return await withExecutionLease({
        source: 'schedule',
        taskName: `任务流程 ${scheduleId}`,
        command: 'schedule'
      }, () => runTaskFlow(taskFlow, scheduleId, executionToken, lifecycle, runId));
    } catch (error) {
      if (error?.code === 'MAA_EXECUTION_BUSY') {
        logger.warn('设备正被其他 MAA 任务占用，跳过任务流程', { scheduleId, owner: error.owner });
        return {
          success: false,
          message: error.message,
          busy: true,
          owner: error.owner
        };
      }
      if (error?.stopped) {
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
          : `任务流程异常终止${unexpectedError?.message ? `: ${unexpectedError.message}` : ''}`;

        logger.error('任务流程未正常收尾，已复位执行状态', {
          scheduleId,
          runId,
          stopped: wasStopped,
          error: unexpectedError?.message || null
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
