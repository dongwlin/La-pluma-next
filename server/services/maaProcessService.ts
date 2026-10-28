import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.ts';
import { getLogContext } from '../utils/logContext.ts';
import { redactLogText } from '../utils/logRedaction.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.js';
import { normalizeCopilotCommandArgs } from './copilotUri.js';
import { prepareMaaTaskCache } from './maaTaskCacheService.ts';
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

/** 实时日志与结构化日志的级别；未知级别在 addLog 回落为 info。 */
export type MaaLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

/** 结构化日志诊断项；code 是稳定的机器可读标识。 */
export type MaaExecutionDiagnosticCode =
  | 'UNKNOWN_DROPS'
  | 'PENGUIN_REPORT_FAILED'
  | 'YITULIU_REPORT_FAILED'
  | 'ADB_CONNECTION_FAILED'
  | 'ACCOUNT_SWITCH_FAILED'
  | 'GAME_START_FAILED';

export interface MaaExecutionDiagnostic {
  code: MaaExecutionDiagnosticCode;
  level: 'WARN' | 'ERROR';
  message: string;
}

/** 实时日志缓冲条目；关联字段只在执行上下文中存在时写入。 */
export interface MaaRealtimeLogEntry {
  time: string;
  level: MaaLogLevel;
  message: string;
  runId?: string;
  operationId?: string;
}

/** 子进程 stdout/stderr 的最小读取端口。 */
export interface MaaChildOutputStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
 * 受管子进程的最小能力。真实 spawn 返回 ChildProcess；测试可用同形状的
 * 假子进程覆盖 close/error、退出码与 kill，不依赖进程组。
 */
export interface MaaChildProcess {
  readonly pid?: number | undefined;
  exitCode: number | null;
  readonly killed?: boolean;
  readonly stdout: MaaChildOutputStream;
  readonly stderr: MaaChildOutputStream;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** spawn 端口选项：detached 与管道 stdio 是进程组停止的前提。 */
export interface MaaProcessSpawnOptions {
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export type MaaSpawn = (
  file: string,
  args: readonly string[],
  options: MaaProcessSpawnOptions
) => MaaChildProcess;

/** 同步命令（execFile）端口选项；输出按 utf8 字符串返回。 */
export interface MaaExecFileOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface MaaExecFileResult {
  stdout: string;
  stderr: string;
}

export type MaaExecFile = (
  file: string,
  args: readonly string[],
  options: MaaExecFileOptions
) => Promise<MaaExecFileResult>;

/** 强制终止计时器句柄；测试端口返回的假句柄只实现 unref。 */
export interface MaaStopTimer {
  unref?(): void;
}

/** 停止端口：平台、进程组/子进程信号与升级计时器均可注入。 */
export interface MaaStopPorts {
  platform?: NodeJS.Platform;
  killProcessGroup?(pid: number, signal: NodeJS.Signals): void;
  killChild?(childProcess: MaaChildProcess, signal: NodeJS.Signals): void;
  setTimeout?(callback: () => void, delayMs: number): MaaStopTimer;
}

/** 进程端口：CLI 路径、spawn 与 execFile 可覆盖。 */
export interface MaaProcessPorts {
  cliPath?: string;
  spawn?: MaaSpawn;
  execFile?: MaaExecFile;
}

export interface MaaStopOptions {
  forceKillDelayMs?: number;
}

/** 停止请求结果；重复停止只返回等待中，不重复发送信号。 */
export interface MaaStopResult {
  success: boolean;
  message: string;
}

/** 前台命令（同步或等待完成）的输出。 */
export interface MaaCommandOutput {
  stdout: string;
  stderr: string;
  command: string;
}

/** 后台命令的接受响应；子进程仍在运行时返回，不代表执行完成。 */
export interface MaaBackgroundStart extends MaaCommandOutput {
  message: string;
}

/** 子进程真实退出（或启动失败）后的结果；signal 与退出码都显式保留。 */
export interface MaaCommandResult extends MaaCommandOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** 命令错误额外字段：后台执行失败时可在不抛出的情况下观察退出信息。 */
export interface MaaCommandError extends Error {
  code?: string | number | null;
  statusCode?: number | null;
  details?: unknown;
  retryable?: boolean;
  exitCode?: number | null;
  /** 退出信号来自子进程或外部错误字段，保持字符串而非信号字面量联合。 */
  signal?: string | null;
  stopped?: boolean;
  stdout?: string;
  stderr?: string;
}

/** 一次命令的完整结局；ok=false 时 error 一定存在，stopped 单独标记取消。 */
export interface MaaCommandOutcome {
  ok: boolean;
  stopped: boolean;
  result: MaaCommandResult;
  error: MaaCommandError | null;
}

/** 子进程已启动的回调载荷。 */
export interface MaaProcessStarted {
  childProcess: MaaChildProcess;
  command: string;
}

/**
 * 执行生命周期回调：onBeforeStart 在取得租约后、spawn 前运行；
 * onSettled 只在子进程实际退出或启动失败时运行，后台 HTTP 返回不会触发。
 */
export interface MaaProcessLifecycle {
  onBeforeStart?(): void | Promise<void>;
  onStarted?(payload: MaaProcessStarted): void;
  onSettled?(outcome: MaaCommandOutcome): void | Promise<void>;
}

export type MaaSettledHandler = (outcome: MaaCommandOutcome) => void | Promise<void>;

/** 对外任务状态投影；不含子进程与计时器引用。 */
export interface MaaTaskStatus {
  isRunning: boolean;
  taskName: string | null;
  startTime: number | null;
  taskType: string | null;
  stopRequested: boolean;
  logs: MaaRealtimeLogEntry[];
}

interface MaaTaskState extends MaaTaskStatus {
  process: MaaChildProcess | null;
  forceKillTimer: MaaStopTimer | null;
}

// 默认进程端口：真实子进程、真实计时器与真实信号发送。测试传入同名键覆盖。
const defaultProcessPorts: Required<MaaProcessPorts> = Object.freeze({
  cliPath: MAA_CLI_PATH,
  spawn,
  execFile: execFilePromise
});

const defaultStopPorts: Required<MaaStopPorts> = Object.freeze({
  platform: process.platform,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => {
    process.kill(-pid, signal);
  },
  killChild: (childProcess: MaaChildProcess, signal: NodeJS.Signals) => {
    childProcess.kill(signal);
  },
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs)
});

// 全局任务状态追踪：子进程投影，只由本模块写入。
const taskStatus: MaaTaskState = {
  isRunning: false,
  taskName: null,
  startTime: null,
  taskType: null, // 'automation', 'combat', 'roguelike'
  process: null, // 保存子进程引用
  stopRequested: false,
  forceKillTimer: null,
  logs: [] // 保存实时日志
};

/** 按字段返回投影；logs 与子进程状态共享同一缓冲，不复制第二份状态。 */
export function getTaskStatus(): MaaTaskStatus {
  return {
    isRunning: taskStatus.isRunning,
    taskName: taskStatus.taskName,
    startTime: taskStatus.startTime,
    taskType: taskStatus.taskType,
    stopRequested: taskStatus.stopRequested,
    logs: taskStatus.logs
  };
}

/**
 * 获取实时日志
 */
export function getRealtimeLogs(lines: unknown = 100): MaaRealtimeLogEntry[] {
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
export function clearRealtimeLogs(): void {
  taskStatus.logs = [];
}

function trimRealtimeLogs(): void {
  if (taskStatus.logs.length > MAX_REALTIME_LOGS) {
    taskStatus.logs.splice(0, taskStatus.logs.length - MAX_REALTIME_LOGS);
  }
}

function appendRealtimeLog(level: MaaLogLevel, message: string): MaaRealtimeLogEntry {
  // 执行归属来自执行上下文而不是发起请求：请求返回后仍在运行的子进程
  // 输出继续携带同一个 runId/operationId。日志内容统一脱敏后再入缓冲。
  const context = getLogContext();
  const entry: MaaRealtimeLogEntry = {
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
export function addLog(level: MaaLogLevel, message: string): void {
  const entry = appendRealtimeLog(level, message);
  // 使用结构化日志，不再使用 console.log；复用已脱敏的文本。
  switch (level) {
    case 'DEBUG':
      logger.debug(entry.message);
      break;
    case 'WARN':
      logger.warn(entry.message);
      break;
    case 'ERROR':
      logger.error(entry.message);
      break;
    case 'SUCCESS':
      logger.success(entry.message);
      break;
    case 'INFO':
    default:
      logger.info(entry.message);
      break;
  }
}

export function getMaaExecutionDiagnostics(stderr: unknown = ''): MaaExecutionDiagnostic[] {
  const output = String(stderr || '');
  const diagnostics: MaaExecutionDiagnostic[] = [];

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

function addExecutionDiagnostics(stderr: unknown): void {
  getMaaExecutionDiagnostics(stderr).forEach(diagnostic => {
    addLog(diagnostic.level, diagnostic.message);
  });
}

/**
 * 设置任务状态
 */
export function setTaskStatus(
  isRunning: boolean,
  taskName: string | null = null,
  taskType: string | null = null,
  process: MaaChildProcess | null = null
): void {
  if (taskStatus.forceKillTimer) {
    clearStopTimer(taskStatus.forceKillTimer);
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

/** 测试端口的计时器句柄不含 Node 内部字段；clearTimeout 对未知句柄是空操作。 */
function clearStopTimer(timer: MaaStopTimer): void {
  clearTimeout(timer as NodeJS.Timeout);
}

function clearTaskStatusForProcess(childProcess: MaaChildProcess): boolean {
  if (taskStatus.process !== childProcess) return false;
  setTaskStatus(false);
  return true;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** execFile 失败的 stderr 来自错误对象，逐字段收窄后按字符串读取。 */
function errorStderrOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

interface CommandOutcomeInput {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  command: string;
  error?: MaaCommandError | null;
  childProcess: MaaChildProcess;
}

function createCommandOutcome({
  code = null,
  signal = null,
  stdout = '',
  stderr = '',
  command,
  error = null,
  childProcess
}: CommandOutcomeInput): MaaCommandOutcome {
  const stopped = Boolean(
    signal || childProcess.killed || (taskStatus.process === childProcess && taskStatus.stopRequested)
  );
  const result: MaaCommandResult = {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    command,
    exitCode: code,
    signal: signal || null
  };
  const failure: MaaCommandError | null = error || (code !== 0 && !stopped
    ? Object.assign(new Error(`命令执行失败，退出码: ${code}`), {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: code,
        signal: signal || null
      })
    : null);
  return {
    ok: !failure && code === 0 && !stopped,
    stopped,
    result,
    error: failure
  };
}

/** copilot URI 归一化由 copilotUri 负责；这里只把返回值收窄为字符串参数。 */
function normalizeCommandArgs(command: string, args: readonly string[]): string[] {
  const normalized: unknown = normalizeCopilotCommandArgs(command, [...args]);
  return Array.isArray(normalized) ? normalized.map(argument => String(argument)) : [...args];
}

/**
 * 执行 MAA CLI 命令（支持后台异步执行）。
 * ports 可覆盖 cliPath/spawn/execFile，测试用假子进程验证状态与输出处理。
 */
export function execMaaCommandUnlocked(
  command: string,
  args?: readonly string[],
  taskName?: null,
  taskType?: string | null,
  waitForCompletion?: boolean,
  silent?: boolean,
  onSettled?: MaaSettledHandler | null,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommandUnlocked(
  command: string,
  args: readonly string[] | undefined,
  taskName: string | null | undefined,
  taskType: string | null | undefined,
  waitForCompletion: true,
  silent?: boolean,
  onSettled?: MaaSettledHandler | null,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommandUnlocked(
  command: string,
  args: readonly string[] | undefined,
  taskName: string,
  taskType: string | null | undefined,
  waitForCompletion: false,
  silent?: boolean,
  onSettled?: MaaSettledHandler | null,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaBackgroundStart>;
export function execMaaCommandUnlocked(
  command: string,
  args: readonly string[] | undefined,
  taskName: string,
  taskType: string | null | undefined,
  waitForCompletion: true,
  silent?: boolean,
  onSettled?: MaaSettledHandler | null,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommandUnlocked(
  command: string,
  args?: readonly string[],
  taskName?: string | null,
  taskType?: string | null,
  waitForCompletion?: boolean,
  silent?: boolean,
  onSettled?: MaaSettledHandler | null,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput | MaaBackgroundStart>;
export async function execMaaCommandUnlocked(
  command: string,
  args: readonly string[] = [],
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion = false,
  silent = false,
  onSettled: MaaSettledHandler | null = null,
  lifecycle: MaaProcessLifecycle = {},
  ports: MaaProcessPorts = {}
): Promise<MaaCommandOutput | MaaBackgroundStart> {
  const taskCache = await prepareMaaTaskCache(command);
  if (!taskCache) {
    return execMaaCommandWithEnv(command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle, process.env, ports);
  }
  const cleanup = async (): Promise<void> => {
    try {
      await taskCache.cleanup();
    } catch (error) {
      logger.warn('清理 MAA 任务缓存失败', { error: errorMessageOf(error) });
    }
  };
  let cleanupOnReturn = true;
  try {
    let settledCallback: MaaSettledHandler | null = onSettled;
    let processLifecycle: MaaProcessLifecycle = lifecycle;
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

function execMaaCommandWithEnv(
  command: string,
  args: readonly string[],
  taskName: string | null,
  taskType: string | null,
  waitForCompletion: boolean,
  silent: boolean,
  onSettled: MaaSettledHandler | null,
  lifecycle: MaaProcessLifecycle,
  env: NodeJS.ProcessEnv,
  ports: MaaProcessPorts = {}
): Promise<MaaCommandOutput | MaaBackgroundStart> {
  const processPorts: Required<MaaProcessPorts> = { ...defaultProcessPorts, ...ports };
  const finalArgs = normalizeCommandArgs(command, args);
  const fullCommand = `${processPorts.cliPath} ${command} ${finalArgs.join(' ')}`;

  // Executors may be stopped while they are still pending. The gate runs after
  // the execution lease is held and before any process is spawned.
  return (async () => {
    await lifecycle.onBeforeStart?.();

    // 静默模式下不输出日志（用于健康检查等频繁调用）
    if (!silent) {
      addLog('INFO', `执行命令: ${fullCommand}, 等待完成: ${waitForCompletion}`);
    }

    // 如果有任务名称且不需要等待完成，使用后台异步执行
    if (taskName && !waitForCompletion) {
      return new Promise<MaaBackgroundStart>((resolve) => {
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
            const level: MaaLogLevel = line.includes('ERROR') ? 'ERROR' : line.includes('WARN') ? 'WARN' : 'INFO';
            appendRealtimeLog(level, line.trim());
          });
        });

        // 设置任务开始状态
        setTaskStatus(true, taskName, taskType, childProcess);
        lifecycle.onStarted?.({ childProcess, command: fullCommand });

        let settled = false;
        const settle = (outcome: MaaCommandOutcome): void => {
          if (settled) return;
          settled = true;
          if (stderr) {
            addExecutionDiagnostics(stderr);
          }
          clearTaskStatusForProcess(childProcess);
          void onSettled?.(outcome);
          void lifecycle.onSettled?.(outcome);
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
      return new Promise<MaaCommandOutput>((resolve, reject) => {
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
            const level: MaaLogLevel = line.includes('ERROR') ? 'ERROR' : line.includes('WARN') ? 'WARN' : 'INFO';
            appendRealtimeLog(level, line.trim());
          });
        });

        // 设置任务开始状态
        setTaskStatus(true, taskName, taskType, childProcess);
        lifecycle.onStarted?.({ childProcess, command: fullCommand });

        let settled = false;
        const settle = (outcome: MaaCommandOutcome): boolean => {
          if (settled) return false;
          settled = true;
          clearTaskStatusForProcess(childProcess);
          void lifecycle.onSettled?.(outcome);
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
            const commandError: MaaCommandError = outcome.error || new Error(diagnostic?.message || '任务已终止');
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
        const errorMessage = errorMessageOf(error);
        const stderr = errorStderrOf(error);
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
  })();
}

/**
 * 终止当前正在运行的任务。
 * `forceKillDelayMs` 控制 SIGTERM 后升级 SIGKILL 的等待时间；关闭流程会在预算内
 * 传入更短的值，避免退出后留下仍在运行的 detach 子进程。缺省保持 3000ms。
 * ports 可覆盖平台、进程组/子进程信号与计时器，用于确定性测试停止升级。
 */
export function stopCurrentTask(options: MaaStopOptions = {}, ports: MaaStopPorts = {}): MaaStopResult {
  const stopPorts: Required<MaaStopPorts> = { ...defaultStopPorts, ...ports };
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
      const sendSignal = (signal: NodeJS.Signals): void => {
        if (stopPorts.platform !== 'win32' && runningProcess.pid) {
          try {
            stopPorts.killProcessGroup(runningProcess.pid, signal);
            return;
          } catch (error) {
            if (errorCodeOf(error) !== 'ESRCH') throw error;
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
          logger.error('强制终止任务失败', { error: errorMessageOf(error) });
        }
      }, forceKillDelayMs);
      taskStatus.forceKillTimer.unref?.();

      return { success: true, message: '已发送终止请求' };
    } catch (error) {
      logger.error('终止任务失败', { error: errorMessageOf(error) });
      addLog('ERROR', `终止任务失败: ${errorMessageOf(error)}`);
      if (taskStatus.process === runningProcess) {
        taskStatus.stopRequested = false;
      }
      return { success: false, message: `终止失败: ${errorMessageOf(error)}` };
    }
  } else {
    // 进程引用不存在，但状态显示正在运行
    // 这种情况可能是任务刚启动还没有进程引用
    addLog('WARN', '任务正在启动中，无法立即终止');
    return { success: false, message: '任务正在启动中，暂时无法终止' };
  }
}
