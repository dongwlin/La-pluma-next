import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.ts';
import { getLogContext } from '../utils/logContext.ts';
import { redactLogText } from '../utils/logRedaction.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.js';
import { normalizeCopilotCommandArgs } from './copilotUri.js';
import { prepareMaaTaskCache } from './maaTaskCacheService.js';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.js';

/**
 * MAA CLI 子进程执行与进程状态投影。
 *
 * 本模块是唯一持有可写子进程状态（taskStatus）和实时日志缓冲的位置：
 * - taskStatus 只回答“当前是否有受管子进程、任务名与停止请求”，不能当作
 *   流程或 Run 终态；执行身份归 agentRunService，设备变更权归
 *   executionCoordinatorService 的租约，是彼此独立的对象。
 * - 命令是否属于设备变更、是否需要先取得租约由 maaExecutionService 决定；
 *   本模块只提供 spawn/execFile 端口、状态更新、停止信号和输出诊断。
 * - spawn、execFile、停止信号与强制终止计时器都可经端口注入，测试可用假
 *   子进程验证状态与停止升级，不需要真实 MAA CLI 或进程组。
 *
 * 结构化日志服务名保持 `MaaService`：既有日志关联约定按该名称读取执行日志，
 * 拆分模块不改变对外日志表面。
 */

const execFilePromise = promisify(execFile);

// MAA CLI 路径
const MAA_CLI_PATH = DEFAULT_MAA_CLI_PATH;

// 读取实时日志和日志文件时的行数上限。MAX_REALTIME_LOGS 是内存保留缓冲，
// 两者独立；对外契约（/logs/recent 与 /runs/current）按 MAX_REALTIME_LOG_LINES 声明。
export const MAX_REALTIME_LOG_LINES = 500;

const MAX_REALTIME_LOGS = Number(process.env.LA_PLUMA_MAX_REALTIME_LOGS || 5000);

// 创建日志记录器
const logger = createLogger('MaaService');

// 默认进程端口：真实子进程、真实计时器与真实信号发送。测试传入同名键覆盖。
const defaultProcessPorts = Object.freeze({
  cliPath: MAA_CLI_PATH,
  spawn,
  execFile: execFilePromise
});

const defaultStopPorts = Object.freeze({
  platform: process.platform,
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  killChild: (childProcess, signal) => childProcess.kill(signal),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
});

// 全局任务状态追踪：子进程投影，只由本模块写入。
const taskStatus = {
  isRunning: false,
  taskName: null,
  startTime: null,
  taskType: null, // 'automation', 'combat', 'roguelike'
  process: null, // 保存子进程引用
  stopRequested: false,
  forceKillTimer: null,
  logs: [] // 保存实时日志
};

/**
 * 获取当前任务执行状态
 */
export function getTaskStatus() {
  const status = { ...taskStatus };
  delete status.process;
  delete status.forceKillTimer;
  return status;
}

/**
 * 获取实时日志
 */
export function getRealtimeLogs(lines = 100) {
  // 直接调用也受限：非法输入回落默认值，有限值截断并夹取到公开行数上限。
  const lineCount = resolveBoundedInteger(lines, {
    defaultValue: 100,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  // 返回最后 N 行日志
  const startIndex = Math.max(0, taskStatus.logs.length - lineCount);
  return taskStatus.logs.slice(startIndex);
}

/**
 * 清空实时日志
 */
export function clearRealtimeLogs() {
  taskStatus.logs = [];
}

function trimRealtimeLogs() {
  if (taskStatus.logs.length > MAX_REALTIME_LOGS) {
    taskStatus.logs.splice(0, taskStatus.logs.length - MAX_REALTIME_LOGS);
  }
}

function appendRealtimeLog(level, message) {
  // 执行归属来自执行上下文而不是发起请求：请求返回后仍在运行的子进程
  // 输出继续携带同一个 runId/operationId。日志内容统一脱敏后再入缓冲。
  const context = getLogContext();
  const entry = {
    time: new Date().toISOString(),
    level,
    message: redactLogText(message)
  };
  if (context.runId) entry.runId = context.runId;
  if (context.operationId) entry.operationId = context.operationId;
  taskStatus.logs.push(entry);
  trimRealtimeLogs();
  return entry;
}

/**
 * 添加日志到缓存
 * 同域拆分模块（如动态任务）通过本端口写入同一实时缓冲与结构化日志，
 * 不各自维护第二份日志状态。
 */
export function addLog(level, message) {
  const entry = appendRealtimeLog(level, message);
  // 使用结构化日志，不再使用 console.log；复用已脱敏的文本。
  const logLevel = level.toLowerCase();
  if (logger[logLevel]) {
    logger[logLevel](entry.message);
  } else {
    logger.info(entry.message);
  }
}

export function getMaaExecutionDiagnostics(stderr = '') {
  const output = String(stderr || '');
  const diagnostics = [];

  if (output.includes('UnknownDrops')) {
    diagnostics.push({
      code: 'UNKNOWN_DROPS',
      level: 'WARN',
      message: '掉落汇报未发送：结算中存在未识别物品，请更新 MaaCore 和资源后重试'
    });
    return diagnostics;
  }

  if (/FailedToReportToPenguinStats/i.test(output)) {
    diagnostics.push({
      code: 'PENGUIN_REPORT_FAILED',
      level: 'WARN',
      message: '企鹅物流汇报失败，请检查网络或用户 ID'
    });
  }
  if (/FailedToReportToYituliu/i.test(output)) {
    diagnostics.push({
      code: 'YITULIU_REPORT_FAILED',
      level: 'WARN',
      message: '一图流汇报失败，请检查网络或用户 ID'
    });
  }

  if (/FailedToConnect|ConnectionError|device\s+[^\s]+\s+not found|no devices\/emulators found|cannot connect to adb/i.test(output)) {
    diagnostics.push({
      code: 'ADB_CONNECTION_FAILED',
      level: 'ERROR',
      message: '模拟器连接失败，请检查 ADB 地址和模拟器状态'
    });
  }
  if (/account.*(?:not found|failed)|(?:switch|select).*account.*failed/i.test(output)) {
    diagnostics.push({
      code: 'ACCOUNT_SWITCH_FAILED',
      level: 'ERROR',
      message: '账号切换失败，请检查账号关键字是否能唯一匹配已登录账号'
    });
  }
  if (/FailedToStartGame|StartGame.*Failed|game client.*not found/i.test(output)) {
    diagnostics.push({
      code: 'GAME_START_FAILED',
      level: 'ERROR',
      message: '游戏启动失败，请检查客户端类型和游戏安装状态'
    });
  }

  return diagnostics;
}

function addExecutionDiagnostics(stderr) {
  getMaaExecutionDiagnostics(stderr).forEach(diagnostic => {
    addLog(diagnostic.level, diagnostic.message);
  });
}

/**
 * 设置任务状态
 */
export function setTaskStatus(isRunning, taskName = null, taskType = null, process = null) {
  if (taskStatus.forceKillTimer) {
    clearTimeout(taskStatus.forceKillTimer);
  }
  taskStatus.isRunning = isRunning;
  taskStatus.taskName = taskName;
  taskStatus.taskType = taskType;
  taskStatus.startTime = isRunning ? Date.now() : null;
  taskStatus.process = process;
  taskStatus.stopRequested = false;
  taskStatus.forceKillTimer = null;

  addLog('INFO', `任务状态更新: ${JSON.stringify({ isRunning, taskName, taskType, hasProcess: !!process })}`);
}

function clearTaskStatusForProcess(childProcess) {
  if (taskStatus.process !== childProcess) return false;
  setTaskStatus(false);
  return true;
}

function createCommandOutcome({ code = null, signal = null, stdout = '', stderr = '', command, error = null, childProcess }) {
  const stopped = Boolean(
    signal || childProcess?.killed || (taskStatus.process === childProcess && taskStatus.stopRequested)
  );
  const result = {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    command,
    exitCode: code,
    signal: signal || null
  };
  return {
    ok: !error && code === 0 && !stopped,
    stopped,
    result,
    error: error || (code !== 0 && !stopped
      ? Object.assign(new Error(`命令执行失败，退出码: ${code}`), {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: code,
          signal: signal || null
        })
      : null)
  };
}

/**
 * 执行 MAA CLI 命令（支持后台异步执行）。
 * ports 可覆盖 cliPath/spawn/execFile，测试用假子进程验证状态与输出处理。
 */
export async function execMaaCommandUnlocked(command, args = [], taskName = null, taskType = null, waitForCompletion = false, silent = false, onSettled = null, lifecycle = {}, ports = {}) {
  const taskCache = await prepareMaaTaskCache(command);
  if (!taskCache) {
    return execMaaCommandWithEnv(command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle, process.env, ports);
  }
  const cleanup = async () => {
    try {
      await taskCache.cleanup();
    } catch (error) {
      logger.warn('清理 MAA 任务缓存失败', { error: error.message });
    }
  };
  let cleanupOnReturn = true;
  try {
    let settledCallback = onSettled;
    let processLifecycle = lifecycle;
    if (taskName && !waitForCompletion) {
      const { onSettled: lifecycleOnSettled, ...startedLifecycle } = lifecycle;
      processLifecycle = startedLifecycle;
      settledCallback = async outcome => {
        await cleanup();
        await onSettled?.(outcome);
        await lifecycleOnSettled?.(outcome);
      };
    }

    const result = await execMaaCommandWithEnv(
      command, args, taskName, taskType, waitForCompletion, silent,
      settledCallback, processLifecycle, taskCache.env, ports
    );
    if (taskName && !waitForCompletion) cleanupOnReturn = false;
    return result;
  } finally {
    if (cleanupOnReturn) await cleanup();
  }
}

async function execMaaCommandWithEnv(command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle, env, ports = {}) {
  const processPorts = { ...defaultProcessPorts, ...ports };
  const finalArgs = normalizeCopilotCommandArgs(command, args);
  const fullCommand = `${processPorts.cliPath} ${command} ${finalArgs.join(' ')}`;

  // Executors may be stopped while they are still pending. The gate runs after
  // the execution lease is held and before any process is spawned.
  await lifecycle.onBeforeStart?.();

  // 静默模式下不输出日志（用于健康检查等频繁调用）
  if (!silent) {
    addLog('INFO', `执行命令: ${fullCommand}, 等待完成: ${waitForCompletion}`);
  }

  // 如果有任务名称且不需要等待完成，使用后台异步执行
  if (taskName && !waitForCompletion) {
    return new Promise((resolve) => {
      // 使用 spawn 而不是 exec，这样可以独立运行
      const childProcess = processPorts.spawn(processPorts.cliPath, [command, ...finalArgs], {
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      // 实时捕获输出
      childProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;

        // 将输出按行分割并添加到日志
        const lines = text.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          appendRealtimeLog('INFO', line.trim());
        });
      });

      childProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;

        // 将错误输出按行分割并添加到日志
        const lines = text.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          const level = line.includes('ERROR') ? 'ERROR' : line.includes('WARN') ? 'WARN' : 'INFO';
          appendRealtimeLog(level, line.trim());
        });
      });

      // 设置任务开始状态
      setTaskStatus(true, taskName, taskType, childProcess);
      lifecycle.onStarted?.({ childProcess, command: fullCommand });

      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        if (stderr) {
          addExecutionDiagnostics(stderr);
        }
        clearTaskStatusForProcess(childProcess);
        onSettled?.(outcome);
        lifecycle.onSettled?.(outcome);
      };

      // 立即返回，不等待命令完成
      resolve({
        stdout: '',
        stderr: '',
        command: fullCommand,
        message: '任务已在后台启动'
      });

      // 在后台继续执行
      childProcess.on('close', (code, signal) => {
        addLog('INFO', `命令执行完成: ${fullCommand}, 退出码: ${code}`);
        if (stdout.trim()) {
          addLog('INFO', `stdout: ${stdout.trim()}`);
        }
        if (stderr) {
          addLog('WARN', `stderr: ${stderr.trim()}`);
        }

        const outcome = createCommandOutcome({ code, signal, stdout, stderr, command: fullCommand, childProcess });
        if (code !== 0) {
          addLog('ERROR', `命令执行失败: ${fullCommand}`);
        }
        settle(outcome);
      });

      childProcess.on('error', (error) => {
        addLog('ERROR', `命令执行错误: ${fullCommand} - ${error.message}`);
        settle(createCommandOutcome({ stdout, stderr, command: fullCommand, error, childProcess }));
      });
    });
  }
  // 需要等待完成（任务流程中的串行执行）
  else if (taskName && waitForCompletion) {
    return new Promise((resolve, reject) => {
      const childProcess = processPorts.spawn(processPorts.cliPath, [command, ...finalArgs], {
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      // 实时捕获输出
      childProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;

        const lines = text.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          appendRealtimeLog('INFO', line.trim());
        });
      });

      childProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;

        const lines = text.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          const level = line.includes('ERROR') ? 'ERROR' : line.includes('WARN') ? 'WARN' : 'INFO';
          appendRealtimeLog(level, line.trim());
        });
      });

      // 设置任务开始状态
      setTaskStatus(true, taskName, taskType, childProcess);
      lifecycle.onStarted?.({ childProcess, command: fullCommand });

      let settled = false;
      const settle = (outcome) => {
        if (settled) return false;
        settled = true;
        clearTaskStatusForProcess(childProcess);
        lifecycle.onSettled?.(outcome);
        return true;
      };

      // 等待命令完成
      childProcess.on('close', (code, signal) => {
        const outcome = createCommandOutcome({ code, signal, stdout, stderr, command: fullCommand, childProcess });
        if (!settle(outcome)) return;
        addLog('INFO', `命令执行完成: ${fullCommand}, 退出码: ${code}`);
        if (stdout.trim()) {
          addLog('INFO', `stdout: ${stdout.trim()}`);
        }
        if (stderr) {
          addExecutionDiagnostics(stderr);
          addLog('WARN', `stderr: ${stderr.trim()}`);
        }

        if (!outcome.ok) {
          addLog('ERROR', `命令执行失败: ${fullCommand}`);
          const diagnostic = getMaaExecutionDiagnostics(stderr)[0];
          const commandError = outcome.error || new Error(diagnostic?.message || '任务已终止');
          if (diagnostic && !outcome.stopped) commandError.message = diagnostic.message;
          commandError.stdout = stdout.trim();
          commandError.stderr = stderr.trim();
          commandError.exitCode = code;
          commandError.signal = signal || null;
          commandError.stopped = outcome.stopped;
          reject(commandError);
        } else {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            command: fullCommand
          });
        }
      });

      childProcess.on('error', (error) => {
        const outcome = createCommandOutcome({ stdout, stderr, command: fullCommand, error, childProcess });
        if (!settle(outcome)) return;
        addLog('ERROR', `命令执行错误: ${fullCommand} - ${error.message}`);
        reject(error);
      });
    });
  }
  // 没有任务名称，使用同步执行（用于配置查询等操作）
  else {
    try {
      const { stdout, stderr } = await processPorts.execFile(processPorts.cliPath, [command, ...finalArgs], {
        env,
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command: fullCommand
      };
    } catch (error) {
      const errorMessage = error.message || '';
      const stderr = error.stderr || '';
      const combinedError = `${errorMessage}\n${stderr}`;

      // 检测常见错误类型
      if (combinedError.includes('Copilot Error')) {
        if (combinedError.includes('Some error occurred during running task')) {
          throw new Error('作业执行失败：干员不满足要求或编队配置有误');
        }
        throw new Error('作业执行失败：' + combinedError);
      }

      if (combinedError.includes('ADB') || combinedError.includes('adb')) {
        throw new Error('ADB 连接失败：请检查模拟器是否已启动，ADB 地址是否正确');
      }

      if (combinedError.includes('timeout') || combinedError.includes('Timeout')) {
        throw new Error('任务执行超时：可能是游戏卡住或网络问题，请检查游戏状态');
      }

      if (combinedError.includes('not found') || combinedError.includes('No such')) {
        throw new Error('资源文件未找到：请检查 MAA 资源是否完整，可尝试运行 maa update');
      }

      throw new Error(`命令执行失败: ${errorMessage}`);
    }
  }
}

/**
 * 终止当前正在运行的任务。
 * `forceKillDelayMs` 控制 SIGTERM 后升级 SIGKILL 的等待时间；关闭流程会在预算内
 * 传入更短的值，避免退出后留下仍在运行的 detach 子进程。缺省保持 3000ms。
 * ports 可覆盖平台、进程组/子进程信号与计时器，用于确定性测试停止升级。
 */
export function stopCurrentTask(options = {}, ports = {}) {
  const stopPorts = { ...defaultStopPorts, ...ports };
  const requestedDelay = Number(options?.forceKillDelayMs);
  const forceKillDelayMs = Number.isFinite(requestedDelay) && requestedDelay > 0
    ? Math.floor(requestedDelay)
    : 3000;
  if (!taskStatus.isRunning) {
    return { success: false, message: '当前没有正在运行的任务' };
  }

  if (taskStatus.process) {
    logger.warn('终止任务', { taskName: taskStatus.taskName });
    addLog('WARN', `正在终止任务: ${taskStatus.taskName}`);

    const runningProcess = taskStatus.process;
    try {
      if (taskStatus.stopRequested) {
        return { success: true, message: '终止请求已发送，正在等待任务退出' };
      }
      taskStatus.stopRequested = true;
      const sendSignal = (signal) => {
        if (stopPorts.platform !== 'win32' && runningProcess.pid) {
          try {
            stopPorts.killProcessGroup(runningProcess.pid, signal);
            return;
          } catch (error) {
            if (error?.code !== 'ESRCH') throw error;
          }
        }
        stopPorts.killChild(runningProcess, signal);
      };

      logger.warn('使用 SIGTERM 请求任务正常退出');
      addLog('WARN', '正在请求任务正常退出');
      sendSignal('SIGTERM');

      taskStatus.forceKillTimer = stopPorts.setTimeout(() => {
        if (taskStatus.process !== runningProcess || runningProcess.exitCode !== null) return;
        try {
          logger.warn('任务未及时退出，升级为 SIGKILL');
          addLog('WARN', '任务未及时退出，正在强制终止');
          sendSignal('SIGKILL');
        } catch (error) {
          logger.error('强制终止任务失败', { error: error.message });
        }
      }, forceKillDelayMs);
      taskStatus.forceKillTimer.unref?.();

      return { success: true, message: '已发送终止请求' };
    } catch (error) {
      logger.error('终止任务失败', { error: error.message });
      addLog('ERROR', `终止任务失败: ${error.message}`);
      if (taskStatus.process === runningProcess) {
        taskStatus.stopRequested = false;
      }
      return { success: false, message: `终止失败: ${error.message}` };
    }
  } else {
    // 进程引用不存在，但状态显示正在运行
    // 这种情况可能是任务刚启动还没有进程引用
    addLog('WARN', '任务正在启动中，无法立即终止');
    return { success: false, message: '任务正在启动中，暂时无法终止' };
  }
}
