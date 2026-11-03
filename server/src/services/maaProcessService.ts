import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.ts';
import { getLogContext } from '../utils/logContext.ts';
import { redactLogText } from '../utils/logRedaction.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { normalizeCopilotCommandArgs } from './copilotUri.ts';
import { prepareMaaTaskCache } from './maaTaskCacheService.ts';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.ts';
import { parsePositiveInteger } from '../config/runtimeConfig.ts';

const execFilePromise = promisify(execFile);

const MAA_CLI_PATH = DEFAULT_MAA_CLI_PATH;

// 读取实时日志和日志文件时的行数上限。MAX_REALTIME_LOGS 是内存保留缓冲，
// 两者独立；对外契约（/logs/recent 与 /runs/current）按 MAX_REALTIME_LOG_LINES 声明。
export const MAX_REALTIME_LOG_LINES = 500;

const DEFAULT_MAX_REALTIME_LOGS = 5000;

/** 实时日志内存缓冲上限；非法环境变量回落默认值，不能变成 NaN 让裁剪失效。 */
function resolveMaxRealtimeLogs(raw: string | undefined): number {
  try {
    return parsePositiveInteger(raw, {
      name: 'LA_PLUMA_MAX_REALTIME_LOGS',
      fallback: DEFAULT_MAX_REALTIME_LOGS
    });
  } catch {
    return DEFAULT_MAX_REALTIME_LOGS;
  }
}

const MAX_REALTIME_LOGS = resolveMaxRealtimeLogs(process.env.LA_PLUMA_MAX_REALTIME_LOGS);
// 身份属于本次服务进程；清空和缓冲淘汰不重置序号，重启后使用新的前缀。
const realtimeLogSourceId = randomUUID();
let realtimeLogSequence = 0;

const logger = createLogger('MaaService');

export type MaaLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

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

export interface MaaRealtimeLogEntry {
  id: string;
  sequence: number;
  time: string;
  level: MaaLogLevel;
  message: string;
  runId?: string;
  operationId?: string;
}

export interface MaaChildOutputStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

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

export interface MaaExecFileOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
  killSignal?: NodeJS.Signals | number;
}

export interface MaaExecFileResult {
  stdout: string;
  stderr: string;
}

export type MaaExecFile = (
  file: string,
  args: readonly string[],
  options: MaaExecFileOptions,
  /** 提供时在子进程对象创建后同步回调；默认端口用它把维护子进程交给调用方登记。 */
  onChild?: (childProcess: MaaChildProcess) => void
) => Promise<MaaExecFileResult>;

export interface MaaStopTimer {
  unref?(): void;
}

export interface MaaStopPorts {
  platform?: NodeJS.Platform;
  killProcessGroup?(pid: number, signal: NodeJS.Signals): void;
  killChild?(childProcess: MaaChildProcess, signal: NodeJS.Signals): void;
  setTimeout?(callback: () => void, delayMs: number): MaaStopTimer;
}

export interface MaaProcessPorts {
  cliPath?: string;
  spawn?: MaaSpawn;
  execFile?: MaaExecFile;
  execFileTimeoutMs?: number;
  /**
   * execFile 分支登记的受管任务名：设置后子进程写入 taskStatus，停止请求与
   * 关闭流程能按同一任务进程路径识别并终止它（Core 安装/更新维护命令使用）。
   */
  managedTaskName?: string | null;
}

export interface MaaStopOptions {
  forceKillDelayMs?: number;
}

export interface MaaStopResult {
  success: boolean;
  message: string;
}

export interface MaaCommandOutput {
  stdout: string;
  stderr: string;
  command: string;
}

/** 后台命令的接受响应；子进程仍在运行时返回，不代表执行完成。 */
export interface MaaBackgroundStart extends MaaCommandOutput {
  message: string;
}

export interface MaaCommandResult extends MaaCommandOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface MaaCommandError extends Error {
  code?: string | number | null;
  statusCode?: number | null;
  details?: unknown;
  retryable?: boolean;
  exitCode?: number | null;
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

/** 无任务名的诊断/配置类 execFile 调用统一使用短超时，避免 CLI 卡死拖住请求。 */
export const MAA_CLI_EXEC_TIMEOUT_MS = 15_000;

/** 维护命令（Core 安装/更新）的默认长超时：真实慢下载应在 15 分钟量级内完成。 */
export const DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS = 900_000;

/** 维护命令长超时的配置上限：单次更新不允许无限等待，超限配置收敛到上限。 */
export const MAX_MAINTENANCE_EXEC_TIMEOUT_MS = 3_600_000;

/**
 * 维护命令专用长超时；缺失或空白回退默认值，非法值与实时日志上限一致静默
 * 回退，超上限收敛到上限。只作用于 install / update 维护命令，短命令默认
 * 15s 时限不受影响。
 */
export function resolveMaintenanceExecTimeoutMs(raw: string | undefined): number {
  try {
    const parsed = parsePositiveInteger(raw, {
      name: 'LA_PLUMA_MAA_MAINTENANCE_TIMEOUT_MS',
      fallback: DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS
    });
    return Math.min(parsed, MAX_MAINTENANCE_EXEC_TIMEOUT_MS);
  } catch {
    return DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS;
  }
}

export const MAINTENANCE_EXEC_TIMEOUT_MS = resolveMaintenanceExecTimeoutMs(process.env.LA_PLUMA_MAA_MAINTENANCE_TIMEOUT_MS);

/**
 * 超时裁决后等待底层子进程退出的宽限：默认端口由 execFile 按 killSignal
 * 终止子进程，close 通常毫秒级到达；端口忽略 timeout 选项时以本宽限兜底。
 */
export const EXEC_FILE_TIMEOUT_EXIT_GRACE_MS = 5_000;

/**
 * 给注入的 execFile 端口再套一层超时，端口忽略 timeout 选项时也不会永久 pending。
 * 超时裁决后先等待底层操作结算（子进程已被终止并退出），再交给调用方超时错误：
 * 调用方的租约与任务状态释放不早于子进程实际终止。
 */
async function withExecFileTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MAA CLI 命令执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (!timedOut) throw error;
    await new Promise<void>(resolve => {
      const graceTimer = setTimeout(resolve, EXEC_FILE_TIMEOUT_EXIT_GRACE_MS);
      graceTimer.unref?.();
      void operation.then(
        () => {
          clearTimeout(graceTimer);
          resolve();
        },
        () => {
          clearTimeout(graceTimer);
          resolve();
        }
      );
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveExecFileTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : MAA_CLI_EXEC_TIMEOUT_MS;
}

/**
 * 默认 execFile 端口：与 promisify(execFile) 同形状，但需要时把子进程对象
 * 同步交给调用方登记（维护命令写 taskStatus），错误对象保留 stdout/stderr。
 */
function execFileWithChild(
  file: string,
  args: readonly string[],
  options: MaaExecFileOptions,
  onChild?: (childProcess: MaaChildProcess) => void
): Promise<MaaExecFileResult> {
  if (!onChild) return execFilePromise(file, args, options);
  return new Promise((resolve, reject) => {
    const childProcess = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    // execFile 固定使用 pipe stdio：stdout/stderr 类型上可空，运行时是可读流。
    const { stdout: stdoutStream, stderr: stderrStream } = childProcess;
    if (!stdoutStream || !stderrStream) {
      reject(new Error('MAA CLI execFile 子进程缺少管道输出流'));
      return;
    }
    onChild(Object.assign(childProcess, { stdout: stdoutStream, stderr: stderrStream }));
  });
}

const defaultProcessPorts: Required<MaaProcessPorts> = Object.freeze({
  cliPath: MAA_CLI_PATH,
  spawn,
  execFile: execFileWithChild,
  execFileTimeoutMs: MAA_CLI_EXEC_TIMEOUT_MS,
  managedTaskName: null
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
  taskType: null,
  process: null,
  stopRequested: false,
  forceKillTimer: null,
  logs: []
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

export function getRealtimeLogs(lines: unknown = 100): MaaRealtimeLogEntry[] {
  // 直接调用也受限：非法输入回落默认值，有限值截断并夹取到公开行数上限。
  const lineCount = resolveBoundedInteger(lines, {
    defaultValue: 100,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  const startIndex = Math.max(0, taskStatus.logs.length - lineCount);
  return taskStatus.logs.slice(startIndex);
}

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
  const sequence = ++realtimeLogSequence;
  const entry: MaaRealtimeLogEntry = {
    id: `${realtimeLogSourceId}:${sequence}`,
    sequence,
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

function errorStderrOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/** 捕获子进程输出时保留的尾部字节数；后台任务再长也不会无界增长。 */
export const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

/** 单条实时输出上限；超长行只记录截断标记，避免丢失凭据前缀后泄露尾部。 */
export const MAX_REALTIME_LOG_LINE_BYTES = 64 * 1024;

/**
 * stdout/stderr 的尾部缓冲：只保留最后 MAX_CAPTURED_OUTPUT_BYTES 字节。
 * 后台执行可能持续很久，直接拼接字符串会让内存随输出线性增长。
 */
class CapturedOutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > MAX_CAPTURED_OUTPUT_BYTES && this.chunks.length > 0) {
      const overflow = this.size - MAX_CAPTURED_OUTPUT_BYTES;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  toString(): string {
    const tail = Buffer.concat(this.chunks);
    let offset = 0;
    // 淘汰旧字节时可能从字符中间开始；丢弃不完整的开头而不制造替换字符。
    while (offset < tail.length && (tail[offset]! & 0xc0) === 0x80) offset += 1;
    return tail.toString('utf-8', offset);
  }
}

/** 按流重建 UTF-8 行；超过单行预算后省略载荷，不能先丢前缀再做脱敏。 */
class OutputLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private readonly onLine: (line: string, level: MaaLogLevel) => void;
  private pending = '';
  private pendingBytes = 0;
  private truncated = false;
  private level: MaaLogLevel = 'INFO';
  private classificationTail = '';

  constructor(onLine: (line: string, level: MaaLogLevel) => void) {
    this.onLine = onLine;
  }

  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    this.emitLine();
  }

  private consume(text: string): void {
    let start = 0;
    let end = text.indexOf('\n');
    while (end !== -1) {
      this.append(text.slice(start, end));
      this.emitLine(true);
      start = end + 1;
      end = text.indexOf('\n', start);
    }
    this.append(text.slice(start));
  }

  private append(text: string): void {
    if (!text) return;
    // 严重度匹配也跨 chunk，且不能因单行尾部裁剪而丢掉开头的 ERROR/WARN。
    const classification = this.classificationTail + text;
    if (classification.includes('ERROR')) this.level = 'ERROR';
    else if (this.level !== 'ERROR' && classification.includes('WARN')) this.level = 'WARN';
    this.classificationTail = classification.slice(-4);
    if (this.truncated) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.pendingBytes + bytes <= MAX_REALTIME_LOG_LINE_BYTES) {
      this.pending += text;
      this.pendingBytes += bytes;
      return;
    }
    this.truncated = true;
    this.pending = '';
    this.pendingBytes = 0;
  }

  private emitLine(terminated = false): void {
    const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    if (terminated || this.pendingBytes > 0 || this.truncated) {
      this.onLine(this.truncated ? '…（单行输出已截断，内容已省略）' : line, this.level);
    }
    this.pending = '';
    this.pendingBytes = 0;
    this.truncated = false;
    this.level = 'INFO';
    this.classificationTail = '';
  }
}

/** maa-cli 在任务结束时打印的报告块标题；紧跟分隔线才按报告合并。 */
const SUMMARY_BLOCK_TITLE = 'Summary';
const SUMMARY_BLOCK_SEPARATOR = /^-{10,}$/;

/** 两种 spawn 执行路径共用采集器；close/error 只冲刷一次未换行的尾部。 */
function captureProcessOutput(childProcess: MaaChildProcess): {
  stdout: CapturedOutputBuffer;
  stderr: CapturedOutputBuffer;
  flush: () => void;
} {
  const stdout = new CapturedOutputBuffer();
  const stderr = new CapturedOutputBuffer();
  let reportTitle: string[] | null = null;
  let reportLines: string[] | null = null;
  let reportBytes = 0;
  let reportTruncated = false;

  // 报告在进程结束才合并：按 UTF-8 字节（含行尾换行）累计，超出实时日志上限就丢弃明细，
  // 避免报告块在内存里无界增长；保留标记让日志侧仍能看到结果。
  const appendReportLine = (entry: string): void => {
    if (!reportLines) return;
    const bytes = Buffer.byteLength(entry, 'utf8') + 1;
    if (reportBytes + bytes > MAX_REALTIME_LOG_LINE_BYTES) {
      reportTruncated = true;
      reportLines = null;
      reportBytes = 0;
      return;
    }
    reportBytes += bytes;
    reportLines.push(entry);
  };

  // 任务报告是一次性的结果而不是流事件：整块合并成一条实时日志，逐行明细仍保留在原文中。
  const emitReport = (): void => {
    if (!reportLines && !reportTruncated) return;
    appendRealtimeLog('INFO', reportLines
      ? reportLines.join('\n')
      : `${SUMMARY_BLOCK_TITLE}: …（任务报告过长，已省略）`);
    reportLines = null;
    reportBytes = 0;
    reportTruncated = false;
  };

  const stdoutLines = new OutputLineDecoder(line => {
    if (reportLines || reportTruncated) {
      appendReportLine(line);
      return;
    }
    if (reportTitle) {
      if (SUMMARY_BLOCK_SEPARATOR.test(line)) {
        reportLines = [];
        reportBytes = 0;
        reportTruncated = false;
        for (const pending of reportTitle) appendReportLine(pending);
        appendReportLine(line);
        reportTitle = null;
        return;
      }
      for (const pending of reportTitle) appendRealtimeLog('INFO', pending);
      reportTitle = null;
    }
    if (line === SUMMARY_BLOCK_TITLE) {
      reportTitle = [line];
      return;
    }
    appendRealtimeLog('INFO', line);
  });
  const stderrLines = new OutputLineDecoder((line, level) => appendRealtimeLog(level, line));
  let finished = false;
  childProcess.stdout.on('data', data => {
    if (finished) return;
    stdout.append(data);
    stdoutLines.write(data);
  });
  childProcess.stderr.on('data', data => {
    if (finished) return;
    stderr.append(data);
    stderrLines.write(data);
  });
  return {
    stdout,
    stderr,
    flush: () => {
      if (finished) return;
      finished = true;
      stdoutLines.end();
      if (reportTitle) {
        for (const pending of reportTitle) appendRealtimeLog('INFO', pending);
        reportTitle = null;
      }
      emitReport();
      stderrLines.end();
    }
  };
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
  // 只有用户/流程明确请求停止时才是 stopped；外部信号（OOM、SIGSEGV、
  // 被其他进程 kill）属于失败，必须保留退出码与信号信息交给上层诊断。
  const stopped = taskStatus.process === childProcess && taskStatus.stopRequested;
  const result: MaaCommandResult = {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    command,
    exitCode: code,
    signal: signal || null
  };
  const failedToExitCleanly = code !== 0 || signal !== null;
  const failureMessage = signal
    ? `命令执行失败，信号: ${signal}`
    : `命令执行失败，退出码: ${code}`;
  const failure: MaaCommandError | null = error || (failedToExitCleanly && !stopped
    ? Object.assign(new Error(failureMessage), {
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
  const finalArgs = normalizeCopilotCommandArgs(command, [...args]);
  const fullCommand = `${processPorts.cliPath} ${command} ${finalArgs.join(' ')}`;

  // Executors may be stopped while they are still pending. The gate runs after
  // the execution lease is held and before any process is spawned.
  return (async () => {
    await lifecycle.onBeforeStart?.();

    if (!silent) {
      addLog('INFO', `执行命令: ${fullCommand}, 等待完成: ${waitForCompletion}`);
    }

    if (taskName && !waitForCompletion) {
      return new Promise<MaaBackgroundStart>((resolve) => {
        // 使用 spawn 而不是 exec，这样可以独立运行
        const childProcess = processPorts.spawn(processPorts.cliPath, [command, ...finalArgs], {
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const { stdout, stderr, flush } = captureProcessOutput(childProcess);

        setTaskStatus(true, taskName, taskType, childProcess);
        lifecycle.onStarted?.({ childProcess, command: fullCommand });

        let settled = false;
        const settle = (outcome: MaaCommandOutcome): void => {
          if (settled) return;
          settled = true;
          if (stderr.toString()) {
            addExecutionDiagnostics(stderr.toString());
          }
          clearTaskStatusForProcess(childProcess);
          void onSettled?.(outcome);
          void lifecycle.onSettled?.(outcome);
        };

        resolve({
          stdout: '',
          stderr: '',
          command: fullCommand,
          message: '任务已在后台启动'
        });

        childProcess.on('close', (code, signal) => {
          if (settled) return;
          flush();
          const stdoutText = stdout.toString();
          const stderrText = stderr.toString();
          const outcome = createCommandOutcome({
            code,
            signal,
            stdout: stdoutText,
            stderr: stderrText,
            command: fullCommand,
            childProcess
          });
          addLog('INFO', outcome.stopped
            ? `命令执行已停止: ${fullCommand}`
            : `命令执行完成: ${fullCommand}, 退出码: ${code}`);
          if (!outcome.stopped && (code !== 0 || signal)) {
            addLog('ERROR', `命令执行失败: ${fullCommand}`);
          }
          settle(outcome);
        });

        childProcess.on('error', (error) => {
          if (settled) return;
          flush();
          addLog('ERROR', `命令执行错误: ${fullCommand} - ${error.message}`);
          settle(createCommandOutcome({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            command: fullCommand,
            error,
            childProcess
          }));
        });
      });
    }
    else if (taskName && waitForCompletion) {
      return new Promise<MaaCommandOutput>((resolve, reject) => {
        const childProcess = processPorts.spawn(processPorts.cliPath, [command, ...finalArgs], {
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const { stdout, stderr, flush } = captureProcessOutput(childProcess);

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

        childProcess.on('close', (code, signal) => {
          if (settled) return;
          flush();
          const stdoutText = stdout.toString();
          const stderrText = stderr.toString();
          const outcome = createCommandOutcome({
            code,
            signal,
            stdout: stdoutText,
            stderr: stderrText,
            command: fullCommand,
            childProcess
          });
          if (!settle(outcome)) return;
          addLog('INFO', outcome.stopped
            ? `命令执行已停止: ${fullCommand}`
            : `命令执行完成: ${fullCommand}, 退出码: ${code}`);
          if (stderrText) {
            addExecutionDiagnostics(stderrText);
          }

          if (!outcome.ok) {
            if (!outcome.stopped) addLog('ERROR', `命令执行失败: ${fullCommand}`);
            const diagnostic = getMaaExecutionDiagnostics(stderrText)[0];
            const commandError: MaaCommandError = outcome.error || new Error(diagnostic?.message || '任务已终止');
            if (diagnostic && !outcome.stopped) commandError.message = diagnostic.message;
            commandError.stdout = stdoutText.trim();
            commandError.stderr = stderrText.trim();
            commandError.exitCode = code;
            commandError.signal = signal || null;
            commandError.stopped = outcome.stopped;
            reject(commandError);
          } else {
            resolve({
              stdout: stdoutText.trim(),
              stderr: stderrText.trim(),
              command: fullCommand
            });
          }
        });

        childProcess.on('error', (error) => {
          if (settled) return;
          flush();
          const outcome = createCommandOutcome({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            command: fullCommand,
            error,
            childProcess
          });
          if (!settle(outcome)) return;
          addLog('ERROR', `命令执行错误: ${fullCommand} - ${error.message}`);
          reject(error);
        });
      });
    }
    else {
      const execFileTimeoutMs = resolveExecFileTimeout(processPorts.execFileTimeoutMs);
      // 维护命令（Core 安装/更新）经 managedTaskName 登记受管子进程：纳入
      // taskStatus 后，停止请求与关闭流程按同一任务进程路径识别并终止它。
      const managedTaskName = processPorts.managedTaskName || null;
      let managedChildProcess: MaaChildProcess | null = null;
      // TS 控制流看不到 onChild 回调内的赋值：finally 经闭包读取以保留联合类型。
      const registeredChildProcess = (): MaaChildProcess | null => managedChildProcess;
      try {
        const { stdout, stderr } = await withExecFileTimeout(
          processPorts.execFile(
            processPorts.cliPath,
            [command, ...finalArgs],
            {
              env,
              maxBuffer: 10 * 1024 * 1024,
              timeout: execFileTimeoutMs,
              killSignal: 'SIGKILL'
            },
            managedTaskName
              ? childProcess => {
                  managedChildProcess = childProcess;
                  setTaskStatus(true, managedTaskName, taskType, childProcess);
                }
              : undefined
          ),
          execFileTimeoutMs
        );

        return {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          command: fullCommand
        };
      } catch (error) {
        const errorMessage = errorMessageOf(error);
        const stderr = errorStderrOf(error);
        const combinedError = `${errorMessage}\n${stderr}`;

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
      } finally {
        const childProcess = registeredChildProcess();
        if (childProcess) {
          // 端口忽略 timeout 选项的兜底：子进程仍存活时强制终止，不留孤儿进程。
          if (childProcess.exitCode === null && !childProcess.killed) {
            try {
              childProcess.kill('SIGKILL');
            } catch {
              // 子进程可能恰好在终止前自行退出。
            }
          }
          // withExecFileTimeout 在超时后等待底层结算：到这里子进程已退出或已启动失败。
          clearTaskStatusForProcess(childProcess);
        }
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
