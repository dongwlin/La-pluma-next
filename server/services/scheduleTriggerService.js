import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { execMaaCommand } from './maaExecutionService.js';
import { updateMaaResources } from './resourceUpdateService.js';
import { withMaaExecutionLease } from './executionCoordinatorService.js';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.js';
import { createLogger } from '../utils/logger.ts';

// 定时触发源：cron 注册、替换、停止与自动更新作业。触发回调只调用注入的
// 执行入口，不持有流程状态；流程执行规则由 scheduleFlowExecution 负责。

const execAsync = promisify(exec);
const logger = createLogger('Scheduler');

// MAA CLI 路径
const MAA_CLI_PATH = DEFAULT_MAA_CLI_PATH;

const SCHEDULE_TRIGGER_TIMEZONE = 'Asia/Shanghai';
const AUTO_UPDATE_SCHEDULE_ID = 'auto-update';

function normalizeScheduleTimes(times) {
  return Array.isArray(times)
    ? [...new Set(times.filter(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)))]
    : [];
}

function cronExpressionForTime(time) {
  const [hour, minute] = String(time).split(':');
  return `${minute} ${hour} * * *`;
}

/**
 * 执行一次自动更新。抽成独立函数供触发源注册表调用，注册本身不包含执行。
 */
export async function runAutoUpdateJob(config = {}) {
  const { time, updateCore, updateCli } = config;

  logger.info('自动更新触发执行', { time });

  try {
    await withMaaExecutionLease({ source: 'auto-update', taskName: '自动更新 MAA', command: 'update' }, async () => {
      if (updateCore) {
        logger.info('开始更新 MaaCore');
        await execMaaCommand('update', []);
        logger.success('MaaCore 更新完成');
        logger.info('开始同步最新 MaaResource');
        const resourceResult = await updateMaaResources();
        logger.success('MaaResource 同步完成', {
          lastUpdated: resourceResult.resource.lastUpdated
        });
      }

      if (updateCli) {
        logger.info('开始更新 MAA CLI');

        // 检查是否在 Docker 环境
        const isDocker = process.env.NODE_ENV === 'production' &&
          await execAsync('test -f /.dockerenv').then(() => true).catch(() => false);

        if (isDocker) {
          // Docker 环境：支持更新，更新会持久化
          try {
            await execAsync(`${MAA_CLI_PATH} self update`);
            logger.success('MAA CLI 更新完成', { environment: 'Docker', persistent: true });
          } catch (error) {
            logger.error('MAA CLI 更新失败', { error: error.message });
          }
        } else {
          // 根据操作系统选择更新方式
          const os = await import('os');
          const platform = os.platform();
          let command;

          if (platform === 'darwin') {
            command = 'brew upgrade maa-cli';
          } else if (platform === 'linux' || platform === 'win32') {
            command = `${MAA_CLI_PATH} self update`;
          } else {
            throw new Error(`不支持的操作系统: ${platform}`);
          }

          await execAsync(command);
          logger.success('MAA CLI 更新完成', { platform });
        }
      }

      logger.success('所有自动更新任务完成');
    });
  } catch (error) {
    logger.error('自动更新失败', { error: error.message });
  }
}

/**
 * 创建定时触发源注册表（cron 计划与自动更新）。
 *
 * 语义：
 * - 按 scheduleId 原子替换：新 job 全部创建并启动成功后才销毁旧 job；全部失败时保留
 *   上一份有效注册，错误输入不会清空既有计划。
 * - 每个 job 的回调在触发时检查注册身份与运行时状态：重配、停止或销毁后已经排队的
 *   旧回调直接丢弃，不会按旧流程或关闭后的状态启动新的执行。
 * - 运行时进入 draining 后回调不再启动日常流程或自动更新；已开始的流程不被本注册表
 *   改写终态，仍由实际执行结算 Run。
 * - stopAll 停止并销毁全部 job，重复调用返回同一摘要；销毁后拒绝新的注册。
 * - cron 与时钟可注入，测试使用假 job 与假时钟。
 */
export function createScheduleTriggerRuntime({
  cronImpl = cron,
  now = () => Date.now(),
  runtimeLogger = logger,
  runScheduleFlow,
  runAutoUpdate = runAutoUpdateJob,
  isDraining = () => false
} = {}) {
  if (typeof runScheduleFlow !== 'function') {
    throw new TypeError('createScheduleTriggerRuntime 缺少 runScheduleFlow 执行端口');
  }

  const registrations = new Map();
  const counters = { triggered: 0, skippedDraining: 0, skippedStale: 0 };
  let drainPredicate = isDraining;
  let closed = false;
  let closeSummary = null;

  function isRuntimeClosing() {
    if (closed) return true;
    if (typeof drainPredicate !== 'function') return false;
    try {
      return Boolean(drainPredicate());
    } catch (error) {
      // 读不到关闭状态时按已关闭处理，避免关闭期间意外启动新执行。
      runtimeLogger.error('读取运行时关闭状态失败，按关闭处理', { error: error.message });
      return true;
    }
  }

  function destroyJob(job, context) {
    try {
      if (typeof job?.destroy === 'function') job.destroy();
      else if (typeof job?.stop === 'function') job.stop();
      return null;
    } catch (error) {
      runtimeLogger.error('定时任务销毁失败', { ...context, error: error.message });
      return error.message;
    }
  }

  function destroyRegistration(registration) {
    if (!registration || registration.destroyed) return [];
    registration.destroyed = true;
    const errors = [];
    for (const entry of registration.jobs) {
      const errorMessage = destroyJob(entry.job, { scheduleId: registration.scheduleId, time: entry.time });
      if (errorMessage) errors.push({ time: entry.time, error: errorMessage });
    }
    return errors;
  }

  function createCronTask(expression, callback) {
    const options = { timezone: SCHEDULE_TRIGGER_TIMEZONE };
    if (typeof cronImpl.createTask === 'function') {
      // v4：createTask 只登记不启动，便于先构造后切换。
      return cronImpl.createTask(expression, callback, options);
    }
    // 兼容只暴露 schedule 的实现：先以 scheduled:false 创建，再统一启动。
    return cronImpl.schedule(expression, callback, { ...options, scheduled: false });
  }

  function startJob(job) {
    if (job && typeof job.start === 'function') job.start();
  }

  function createTrigger(registration, time, triggerScheduleId, run) {
    return () => {
      if (isRuntimeClosing()) {
        counters.skippedDraining += 1;
        runtimeLogger.info('运行时正在关闭，忽略已排队的定时触发', {
          scheduleId: triggerScheduleId,
          time,
          at: now()
        });
        return;
      }
      if (registration.destroyed || registrations.get(registration.scheduleId) !== registration) {
        counters.skippedStale += 1;
        runtimeLogger.debug('定时触发已失效，忽略已排队的回调', {
          scheduleId: triggerScheduleId,
          time,
          at: now()
        });
        return;
      }
      counters.triggered += 1;
      let pending;
      try {
        // 同步调用执行入口：准入与 Run 创建之间不插入 await，避免 draining 从中间插入。
        pending = run();
      } catch (error) {
        runtimeLogger.error('定时触发执行失败', {
          scheduleId: triggerScheduleId,
          time,
          error: error.message
        });
        return;
      }
      Promise.resolve(pending).catch(error => {
        runtimeLogger.error('定时触发执行失败', {
          scheduleId: triggerScheduleId,
          time,
          error: error?.message || String(error)
        });
      });
    };
  }

  function buildRegistration({ scheduleId, kind, times, taskFlow = null, config = null, makeRun }) {
    const registration = {
      scheduleId,
      kind,
      times: [],
      // 注册时快照配置，之后的请求体或配置对象变动不影响已登记的触发。
      taskFlow: Array.isArray(taskFlow) ? [...taskFlow] : null,
      config: config && typeof config === 'object' ? { ...config } : config,
      jobs: [],
      registeredAt: now(),
      destroyed: false
    };
    const prepared = [];
    const failures = [];
    times.forEach((time, index) => {
      const triggerScheduleId = kind === 'schedule' ? `${scheduleId}-${index}` : scheduleId;
      const run = () => makeRun(registration, time, triggerScheduleId);
      try {
        const job = createCronTask(
          cronExpressionForTime(time),
          createTrigger(registration, time, triggerScheduleId, run)
        );
        prepared.push({ time, job });
      } catch (error) {
        failures.push({ time, error: error.message });
        runtimeLogger.error('定时任务设置失败', {
          scheduleId: triggerScheduleId,
          time,
          error: error.message
        });
      }
    });
    return { registration, prepared, failures };
  }

  /**
   * 启动新 job 并切换到新注册。新 job 启动失败时不销毁旧注册；切换后旧 job 的排队
   * 回调会因身份不匹配被丢弃。返回 null 表示没有任何 job 启动成功。
   */
  function installRegistration({ registration, prepared, failures }) {
    const started = [];
    for (const entry of prepared) {
      try {
        startJob(entry.job);
        started.push(entry);
      } catch (error) {
        failures.push({ time: entry.time, error: error.message });
        destroyJob(entry.job, { scheduleId: registration.scheduleId, time: entry.time });
        runtimeLogger.error('定时任务启动失败', {
          scheduleId: registration.scheduleId,
          time: entry.time,
          error: error.message
        });
      }
    }
    if (started.length === 0) return null;

    registration.times = started.map(entry => entry.time);
    registration.jobs = started;
    const previous = registrations.get(registration.scheduleId);
    registrations.set(registration.scheduleId, registration);
    if (previous && previous !== registration) destroyRegistration(previous);
    return registration;
  }

  function setupSchedule(scheduleId, times, taskFlow) {
    if (!Array.isArray(taskFlow)) {
      return { success: false, message: '任务流程格式无效' };
    }

    const normalizedTimes = normalizeScheduleTimes(times);
    if (normalizedTimes.length === 0) {
      return { success: false, message: '没有设置执行时间' };
    }
    if (isRuntimeClosing()) {
      return { success: false, message: '运行时正在关闭，无法设置定时任务' };
    }

    const { registration, prepared, failures } = buildRegistration({
      scheduleId,
      kind: 'schedule',
      times: normalizedTimes,
      taskFlow,
      makeRun: (current, time, triggerScheduleId) => {
        runtimeLogger.info('定时任务触发执行', { scheduleId: triggerScheduleId, time });
        return runScheduleFlow(current.taskFlow, triggerScheduleId);
      }
    });
    const installed = installRegistration({ registration, prepared, failures });
    if (!installed) {
      runtimeLogger.warn('定时任务未更新，保留上一份有效注册', {
        scheduleId,
        times: normalizedTimes
      });
      return { success: false, message: '没有成功设置任何定时任务' };
    }

    runtimeLogger.info('定时任务已设置', {
      scheduleId,
      count: installed.jobs.length,
      times: installed.times.join(', ')
    });
    return {
      success: true,
      message: `已设置 ${installed.jobs.length} 个定时任务`,
      times: [...installed.times]
    };
  }

  function setupAutoUpdate(config = {}) {
    const { enabled, time } = config;

    // 显式禁用或缺少时间点表示停止自动更新；无效输入不清空既有有效注册。
    if (!enabled || !time) {
      const previous = registrations.get(AUTO_UPDATE_SCHEDULE_ID);
      if (previous) {
        registrations.delete(AUTO_UPDATE_SCHEDULE_ID);
        destroyRegistration(previous);
      }
      return { success: false, message: '自动更新未启用' };
    }

    const [hour, minute] = String(time).split(':');
    if (!hour || !minute) {
      return { success: false, message: '时间格式错误' };
    }
    if (isRuntimeClosing()) {
      return { success: false, message: '运行时正在关闭，无法设置自动更新' };
    }

    const { registration, prepared, failures } = buildRegistration({
      scheduleId: AUTO_UPDATE_SCHEDULE_ID,
      kind: 'auto-update',
      times: [time],
      config,
      makeRun: current => runAutoUpdate(current.config)
    });
    const installed = installRegistration({ registration, prepared, failures });
    if (!installed) {
      const reason = failures[0]?.error || '没有成功设置自动更新任务';
      runtimeLogger.error('自动更新设置失败', { error: reason });
      return { success: false, message: `设置失败: ${reason}` };
    }

    runtimeLogger.info('自动更新已设置', { time });
    return {
      success: true,
      message: `自动更新已设置，每天 ${time} 执行`,
      config
    };
  }

  function stopSchedule(scheduleId) {
    const registration = registrations.get(scheduleId);
    if (!registration) {
      // 重复停止是幂等的：目标状态已满足，返回与首次停止一致的成功结果。
      runtimeLogger.debug('定时任务未注册，停止请求按已完成处理', { scheduleId });
      return { success: true, message: '定时任务已停止' };
    }
    registrations.delete(scheduleId);
    destroyRegistration(registration);
    runtimeLogger.debug('定时任务已停止', {
      scheduleId,
      count: registration.jobs.length,
      times: registration.times.join(', ')
    });
    return { success: true, message: '定时任务已停止' };
  }

  /**
   * 停止并销毁全部触发源。关闭后不再接受注册；重复调用返回首次摘要。
   */
  function stopAll(reason = 'shutdown') {
    if (closeSummary) return closeSummary;

    const startedAt = now();
    const stopped = [];
    const errors = [];
    for (const [scheduleId, registration] of [...registrations.entries()]) {
      registrations.delete(scheduleId);
      const destroyErrors = destroyRegistration(registration);
      if (destroyErrors.length > 0) errors.push({ scheduleId, errors: destroyErrors });
      stopped.push({
        scheduleId,
        kind: registration.kind,
        times: [...registration.times],
        count: registration.jobs.length
      });
    }

    closed = true;
    const stoppedAt = now();
    closeSummary = {
      reason,
      ok: errors.length === 0,
      stoppedAt,
      durationMs: stoppedAt - startedAt,
      stopped,
      ...(errors.length > 0 ? { errors } : {})
    };
    runtimeLogger.info('定时触发源已停止', {
      reason,
      count: stopped.length,
      ok: closeSummary.ok
    });
    return closeSummary;
  }

  function getStatus() {
    return [...registrations.values()].map(registration => ({
      scheduleId: registration.scheduleId,
      times: [...registration.times],
      count: registration.jobs.length
    }));
  }

  function getAutoUpdateStatus() {
    const registration = registrations.get(AUTO_UPDATE_SCHEDULE_ID);
    if (registration && registration.jobs.length > 0) {
      return { enabled: true, time: registration.times[0] };
    }
    return { enabled: false, time: null };
  }

  function describe() {
    return {
      closed,
      draining: isRuntimeClosing(),
      counters: { ...counters },
      registrations: [...registrations.values()].map(registration => ({
        scheduleId: registration.scheduleId,
        kind: registration.kind,
        times: [...registration.times],
        count: registration.jobs.length,
        registeredAt: registration.registeredAt
      })),
      closeSummary
    };
  }

  function setDrainPredicate(predicate) {
    drainPredicate = typeof predicate === 'function' ? predicate : () => false;
  }

  return {
    setupSchedule,
    setupAutoUpdate,
    stopSchedule,
    stopAll,
    getStatus,
    getAutoUpdateStatus,
    describe,
    setDrainPredicate
  };
}

const attachedLifecycles = new WeakMap();

/**
 * 把触发源注册表接入运行时生命周期：draining 后停止响应 cron 触发，关闭步骤停止并
 * 销毁全部 job。同一 lifecycle 重复接入不重复注册；同一 lifecycle 不能挂接两个注册表。
 */
export function attachScheduleTriggersToLifecycle(lifecycle, runtime) {
  if (!lifecycle || typeof lifecycle.register !== 'function') {
    return { attached: false, duplicate: false };
  }
  if (!runtime || typeof runtime.setDrainPredicate !== 'function') {
    throw new TypeError('attachScheduleTriggersToLifecycle 需要触发源注册表');
  }
  const attachedRuntime = attachedLifecycles.get(lifecycle);
  if (attachedRuntime) {
    if (attachedRuntime !== runtime) {
      throw new Error('运行时生命周期已挂接其他调度触发源注册表');
    }
    return { attached: true, duplicate: true };
  }

  // 先挂关闭判断：即使随后注册关闭步骤失败（例如 lifecycle 已进入 draining），
  // 触发源也不会在关闭期间再接受新注册或响应已排队的回调。
  runtime.setDrainPredicate(() => (
    typeof lifecycle.isDraining === 'function' ? lifecycle.isDraining() : false
  ));
  lifecycle.register({
    name: 'scheduled-triggers',
    close: () => {
      const summary = runtime.stopAll('runtime-close');
      if (!summary.ok) {
        // 让生命周期把本步骤记为失败，但不阻断其余领域的收尾。
        const failed = (summary.errors || [])
          .map(entry => `${entry.scheduleId}:${entry.errors.map(detail => detail.error).join(',')}`)
          .join('; ');
        throw new Error(`定时触发源停止未完全成功: ${failed || '未知错误'}`);
      }
      return summary;
    }
  });
  attachedLifecycles.set(lifecycle, runtime);
  return { attached: true, duplicate: false };
}
