/**
 * WebRTC 预览运行时：本地信令服务、TURN、设备端 Agent 与 viewer 会话
 *
 * - 进程所有权：只终止本实例启动的 server/TURN/Agent 部署/构建子进程，设备端
 *   Agent 只停止已登记所有权的地址；启动前已存在的资源记为 external，停止与
 *   关闭流程都不会杀掉它们。停止与关闭对托管子进程先 SIGTERM，短宽限期后
 *   以 SIGKILL 收尾，不依赖子进程对 SIGTERM 的响应时机。
 * - viewer 生命周期：同一设备最后一个浏览器离开后按 idle 宽限期回收 Agent；
 *   新 viewer 会取消排队中的回收并在建立上游连接前确认（必要时恢复）Agent。
 * - 启动队列：所有启动/停止/安装串行执行；关闭一旦开始，排队中与在途的步骤
 *   都以 `WEBRTC_PREVIEW_CLOSED` 结束，不再派生或占用新资源。
 * - 超时：等待上游就绪、ADB 设备、TURN 监听与设备注册都带显式时限与可注入
 *   轮询，失败时抛出具名错误码，不能把“还在等待”当成成功。
 * - 外部边界：上游 `/api/login` 与 `/devices` 的 JSON、设备标识和子进程退出
 *   状态都按 unknown 收窄；无效值按既有格式错误处理，不使用宽泛 any。
 *
 * 同源网关（`webrtcSignalingGateway.ts`）只通过 `registerWebrtcViewer`、
 * `getWebrtcAuthToken` 与本模块交互，不直接持有进程或计时器。
 */

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ExecFileOptions, SpawnOptionsWithoutStdio } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';
import { resolveWebrtcCredentials } from '../config/webrtcCredentials.ts';
import { getWebrtcHostIp, getWebrtcRuntimeBinary, installWebrtcRelease } from './webrtcRuntime.ts';
import type { RuntimeLifecycleStep } from './runtimeLifecycleService.ts';

const execFileAsync = promisify(execFile);

export { DEFAULT_ADB_PATH };

const WEBRTC_DIR = process.env.LA_PLUMA_WEBRTC_DIR || `${process.env.HOME || ''}/ScrcpyOverWebRTC`;
export const WEBRTC_PORT = Number(process.env.LA_PLUMA_WEBRTC_PORT || 8443);
const WEBRTC_TURN_PORT = Number(process.env.LA_PLUMA_WEBRTC_TURN_PORT || 3478);
export const DEFAULT_DEVICE_ADDRESS = DEFAULT_ADB_ADDRESS;
export const DEFAULT_DEVICE_ID = 'mumu-la-pluma';

const WEBRTC_REQUEST_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_REQUEST_TIMEOUT_MS, 1500);
const WEBRTC_SERVER_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_SERVER_START_TIMEOUT_MS, 15000);
const WEBRTC_AGENT_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_AGENT_START_TIMEOUT_MS, 20000);
const WEBRTC_TURN_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_TURN_START_TIMEOUT_MS, 5000);
const WEBRTC_START_POLL_INTERVAL_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_START_POLL_INTERVAL_MS, 250);
const WEBRTC_VIEWER_IDLE_GRACE_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS, 3000);
const WEBRTC_VIEWER_STARTUP_GRACE_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_VIEWER_STARTUP_GRACE_MS, 15000);
/** SIGTERM 之后的强制收尾宽限期；仍存活的托管子进程在超时后以 SIGKILL 结束。 */
const WEBRTC_PROCESS_KILL_GRACE_MS = 500;

/** 资源归属：managed 由本实例启动并登记，external 是启动前已存在或其它实例的资源。 */
export type WebrtcOwnershipState = 'managed' | 'external' | 'none';

/** 停止/关闭时实际释放的资源名；只报告本实例拥有的资源。 */
export type WebrtcReleasedResource = 'server' | 'turn' | 'agent-deployment' | 'device-agent';

export type WebrtcProcessKind = 'server' | 'agent' | 'turn';

export interface WebrtcOwnership {
  server: WebrtcOwnershipState;
  turn: WebrtcOwnershipState;
  agent: WebrtcOwnershipState;
}

export interface WebrtcLogPaths {
  serverLog: string;
  agentLog: string;
  turnLog: string;
}

/** 预览状态快照；既有字段与所有权报告保持兼容。 */
export interface WebrtcStatus {
  installed: boolean;
  built: boolean;
  dir: string;
  port: number;
  url: string;
  lanUrl: string;
  signalingUrl: string;
  directSignalingUrl: string;
  turnRunning: boolean;
  iceServers: string;
  serverRunning: boolean;
  agentRunning: boolean;
  ownership: WebrtcOwnership;
  deviceAddress: string;
  serverLog: string;
  agentLog: string;
  turnLog: string;
}

/** Agent 启动成功后的状态；agentRunning 由本模块确认，不来自上游推断。 */
export type WebrtcRunningStatus = WebrtcStatus & { agentRunning: true };

/** 停止/关闭响应：状态快照加上本次实际释放的资源。 */
export interface WebrtcStopResult extends WebrtcStatus {
  released: WebrtcReleasedResource[];
}

export interface WebrtcStopSummary {
  stopped: true;
  released: WebrtcReleasedResource[];
}

/** 只读取子进程退出状态的投影；真实 ChildProcess 与测试替身都满足。 */
export interface WebrtcProcessState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | string | null;
}

/** 带稳定错误码的预览错误；retryable 仅用于区分临时等待失败。 */
export interface WebrtcRuntimeError extends Error {
  code: string;
  retryable?: boolean;
  cause?: unknown;
  /** build.sh 非零退出时保留的退出码 */
  exitCode?: number | null;
}

/** 一次浏览器预览会话；release 幂等，ready 在 Agent 可用后完成。 */
export interface WebrtcViewerLease {
  ready: Promise<unknown>;
  release(): void;
}

/** idle 回收结果：retry 表示上游仍有观看者，需要重新排队等待。 */
export interface WebrtcIdleReleaseResult {
  stopped?: boolean;
  retry?: boolean;
  closed?: boolean;
}

/** viewer 计时器与回收端口；releaseIdle/restore 由本模块接到生命周期队列。 */
export interface WebrtcViewerLifecycleOptions {
  idleGraceMs?: number;
  startupGraceMs?: number;
  releaseIdle?: (deviceId: string, generation: number, isIdle: () => boolean) => unknown;
  restore?: (deviceId: string) => unknown;
  onError?: (error: Error) => void;
}

export interface WebrtcViewerLifecycle {
  started(deviceId: string, generation: number): void;
  stopped(deviceId: string): void;
  retain(deviceId?: string | null): WebrtcViewerLease;
  close(): void;
}

/** 运行时关闭步骤的注册端口；`isDraining` 用于拒绝 draining 后开始的预览操作。 */
export interface WebrtcPreviewLifecycle {
  register(step: RuntimeLifecycleStep): unknown;
  isDraining?(): boolean;
}

/** 设备端 Agent 的所有权记录：只停止与记录完全一致的地址与设备。 */
interface WebrtcAgentOwner {
  address: string;
  deviceId: string;
  adbPath: string;
  generation: number;
}

/** 上游 `/devices` 的条目投影；clientCount 为 0 表示没有上游观看者。 */
interface WebrtcDeviceDetails {
  deviceId: string;
  clientCount: number;
  hasClients: boolean;
}

let webrtcServerProcess: ChildProcess | null = null;
let webrtcAgentProcess: ChildProcess | null = null;
let webrtcTurnProcess: ChildProcess | null = null;
let webrtcBuildProcess: ChildProcess | null = null;
let webrtcLifecycleQueue: Promise<void> = Promise.resolve();
let registeredAgentOwner: WebrtcAgentOwner | null = null;
let idleStoppedAgentOwner: WebrtcAgentOwner | null = null;
let agentGeneration = 0;
const processStartupErrors = new WeakMap<WebrtcProcessState, Error>();

// 预览运行时是进程级单例：关闭一旦开始，同一进程不再启动新的预览资源。
// closeAbort 用于取消关闭时仍在等待的启动/停止步骤，避免它们继续派生或占用资源。
let closeRequested = false;
const closeAbort = new AbortController();
const attachedLifecycles = new WeakSet<WebrtcPreviewLifecycle>();
let attachedLifecycle: WebrtcPreviewLifecycle | null = null;

// Register before waiting on the lifecycle queue so a new browser prevents a
// queued idle stop. If stopping has already begun, its upgrade waits for restore.
const viewerLifecycle: WebrtcViewerLifecycle = createWebrtcViewerLifecycle({
  idleGraceMs: WEBRTC_VIEWER_IDLE_GRACE_MS,
  startupGraceMs: WEBRTC_VIEWER_STARTUP_GRACE_MS,
  releaseIdle: (deviceId, generation, isIdle) => enqueueLifecycle(
    () => stopIdleWebrtcAgentUnlocked(deviceId, generation, isIdle)
  ).catch(error => {
    // 关闭流程已取消的自动回收不再重试，也不再告警。
    if (isPreviewClosed(error)) return { stopped: false, closed: true };
    throw error;
  }),
  restore: deviceId => enqueueLifecycle(async () => {
    const owner = idleStoppedAgentOwner;
    if (!owner || owner.deviceId !== deviceId) return;
    if (registeredAgentOwner) return;
    await startWebrtcAgentUnlocked(owner.address, owner.deviceId, owner.adbPath);
  })
});

/**
 * 创建 viewer 计时器集合。
 *
 * `started` 记录设备 Agent 的当前代次并开始启动宽限；`retain` 登记一次浏览器
 * 会话并取消待执行的回收；最后一个 viewer 释放后按 idle 宽限期调用 releaseIdle。
 * 旧网关连接不携带设备标识时按全局 viewer 保守处理，阻止任何设备的自动回收。
 */
export function createWebrtcViewerLifecycle({
  idleGraceMs = 3000,
  startupGraceMs = 15000,
  releaseIdle,
  restore = async () => {},
  onError = error => console.warn('[WebRTC] Idle preview cleanup failed:', error.message)
}: WebrtcViewerLifecycleOptions = {}): WebrtcViewerLifecycle {
  interface ViewerDevice {
    viewers: Set<object>;
    generation: number | null;
    timer: NodeJS.Timeout | null;
  }

  const devices = new Map<string, ViewerDevice>();
  const unscopedViewers = new Set<object>();

  function getDevice(deviceId: string): ViewerDevice {
    if (!devices.has(deviceId)) devices.set(deviceId, { viewers: new Set(), generation: null, timer: null });
    return devices.get(deviceId) as ViewerDevice;
  }

  function cancelIdle(device: ViewerDevice): void {
    if (device.timer) clearTimeout(device.timer);
    device.timer = null;
  }

  function scheduleIdle(deviceId: string, device: ViewerDevice, graceMs: number): void {
    cancelIdle(device);
    if (device.generation === null) {
      if (!device.viewers.size && devices.get(deviceId) === device) devices.delete(deviceId);
      return;
    }
    if (device.viewers.size || unscopedViewers.size) return;
    const generation = device.generation;
    const isIdle = (): boolean => devices.get(deviceId) === device && device.generation === generation
      && !device.viewers.size && !unscopedViewers.size;
    device.timer = setTimeout(() => {
      device.timer = null;
      if (!isIdle()) return;
      Promise.resolve().then(() => releaseIdle?.(deviceId, generation, isIdle)).then(result => {
        if (isIdle() && isIdleReleaseRetry(result)) scheduleIdle(deviceId, device, idleGraceMs);
      }).catch(error => {
        onError(error instanceof Error ? error : new Error(String(error)));
        if (isIdle()) scheduleIdle(deviceId, device, idleGraceMs);
      });
    }, graceMs);
    device.timer.unref?.();
  }

  return {
    started(deviceId, generation) {
      const device = getDevice(deviceId);
      device.generation = generation;
      scheduleIdle(deviceId, device, startupGraceMs);
    },
    stopped(deviceId) {
      const device = devices.get(deviceId);
      if (!device) return;
      cancelIdle(device);
      device.generation = null;
      if (!device.viewers.size) devices.delete(deviceId);
    },
    retain(deviceId) {
      const token = {};
      const scopedDeviceId = deviceId ? deviceId : null;
      const device = scopedDeviceId ? getDevice(scopedDeviceId) : null;
      const viewers = device?.viewers || unscopedViewers;
      viewers.add(token);
      if (device) cancelIdle(device);
      else for (const entry of devices.values()) cancelIdle(entry);
      let released = false;
      return {
        ready: scopedDeviceId ? Promise.resolve(restore(scopedDeviceId)) : Promise.resolve(),
        release() {
          if (released) return;
          released = true;
          viewers.delete(token);
          if (device && scopedDeviceId) scheduleIdle(scopedDeviceId, device, idleGraceMs);
          else for (const [id, entry] of devices) scheduleIdle(id, entry, idleGraceMs);
        }
      };
    },
    close() {
      for (const device of devices.values()) cancelIdle(device);
      devices.clear();
      unscopedViewers.clear();
    }
  };
}

export function registerWebrtcViewer(deviceId?: string | null): WebrtcViewerLease {
  return viewerLifecycle.retain(deviceId);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取错误码而不信任 catch 值的形状。 */
function readErrorCode(value: unknown): string | null {
  if (!isRecord(value) && !(value instanceof Error)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isPreviewClosed(error: unknown): boolean {
  return readErrorCode(error) === 'WEBRTC_PREVIEW_CLOSED';
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable !== false;
}

function isIdleReleaseRetry(result: unknown): boolean {
  return isRecord(result) && result.retry === true;
}

function createWebrtcError(
  message: string,
  code: string,
  { retryable, cause }: { retryable?: boolean; cause?: unknown } = {}
): WebrtcRuntimeError {
  const error = new Error(message) as WebrtcRuntimeError;
  error.code = code;
  if (retryable !== undefined) error.retryable = retryable;
  if (cause) error.cause = cause;
  return error;
}

function previewClosedError(cause?: unknown): WebrtcRuntimeError {
  return createWebrtcError('WebRTC 预览运行时已进入关闭流程，操作已取消', 'WEBRTC_PREVIEW_CLOSED', {
    retryable: false,
    cause
  });
}

function assertPreviewOpen(): void {
  if (closeRequested) throw previewClosedError();
  // 运行时关闭流程进入 draining 后，排队中的启动/停止不再开始。
  if (attachedLifecycle?.isDraining?.()) throw previewClosedError();
}

function getCloseSignal(): AbortSignal {
  return closeAbort.signal;
}

function enqueueLifecycle<Result>(operation: () => Promise<Result>): Promise<Result> {
  const run = (): Promise<Result> => {
    // 关闭请求可能在操作排队后到达：排队中的启动/停止不能再触碰新资源。
    assertPreviewOpen();
    return operation();
  };
  const pending = webrtcLifecycleQueue.then(run, run);
  webrtcLifecycleQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function isChildProcessRunning(child: ChildProcess | null | undefined): child is ChildProcess {
  return Boolean(child && !child.killed && child.exitCode === null && child.signalCode === null);
}

function terminateManagedProcess(
  child: ChildProcess | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM'
): void {
  if (!isChildProcessRunning(child)) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back when the child did not establish its process group.
    }
  }
  child.kill(signal);
}

function clearManagedProcess(type: WebrtcProcessKind, child: ChildProcess): void {
  if (type === 'server' && webrtcServerProcess === child) webrtcServerProcess = null;
  if (type === 'agent' && webrtcAgentProcess === child) webrtcAgentProcess = null;
  if (type === 'turn' && webrtcTurnProcess === child) webrtcTurnProcess = null;
}

function trackManagedProcess(child: ChildProcess, type: WebrtcProcessKind): ChildProcess {
  child.once('error', error => {
    processStartupErrors.set(child, error);
    clearManagedProcess(type, child);
  });
  child.once('exit', () => clearManagedProcess(type, child));
  return child;
}

function spawnWithLog(
  command: string,
  args: readonly string[],
  logPath: string,
  options: SpawnOptionsWithoutStdio
): ChildProcess {
  const logFd = openSync(logPath, 'a');
  try {
    return spawn(command, args, {
      ...options,
      stdio: ['ignore', logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }
}

function processStartupFailure(
  child: WebrtcProcessState | null | undefined,
  label: string,
  { allowSuccessfulExit = false }: { allowSuccessfulExit?: boolean } = {}
): WebrtcRuntimeError | null {
  if (!child) return null;
  const spawnError = processStartupErrors.get(child);
  if (spawnError) {
    return createWebrtcError(`${label}进程启动失败：${spawnError.message}`, 'WEBRTC_PROCESS_START_FAILED', {
      retryable: false
    });
  }
  if (child.signalCode !== null || (child.exitCode !== null && (!allowSuccessfulExit || child.exitCode !== 0))) {
    const reason = child.signalCode ? `信号 ${child.signalCode}` : `退出码 ${child.exitCode}`;
    return createWebrtcError(`${label}进程在就绪前退出（${reason}）`, 'WEBRTC_PROCESS_EXITED', {
      retryable: false
    });
  }
  return null;
}

export interface WaitForConditionOptions<Result> {
  timeoutMs: number;
  pollIntervalMs?: number;
  timeoutMessage: string;
  timeoutCode?: string;
  signal?: AbortSignal | null;
}

/**
 * 轮询直到 check 返回非 false 的结果。
 *
 * 关闭 signal 一旦 abort，立即以 `WEBRTC_PREVIEW_CLOSED` 结束；带
 * `retryable: false` 的错误直接抛出，其余错误在超时消息中保留最后一次原因。
 */
export async function waitForCondition<Result>(
  check: () => Result | false | Promise<Result | false>,
  {
    timeoutMs,
    pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
    timeoutMessage,
    timeoutCode = 'WEBRTC_START_TIMEOUT',
    signal = null
  }: WaitForConditionOptions<Result>
): Promise<Result> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (true) {
    if (signal?.aborted) throw previewClosedError();
    try {
      const result = await check();
      if (result) {
        if (signal?.aborted) throw previewClosedError();
        return result;
      }
      lastError = null;
    } catch (error) {
      if (signal?.aborted) throw previewClosedError(error);
      if (!isRetryable(error)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      const detail = lastError?.message ? `；最后一次检查失败：${lastError.message}` : '';
      throw createWebrtcError(`${timeoutMessage}${detail}`, timeoutCode, {
        cause: lastError ?? undefined
      });
    }
    const waitMs = Math.min(pollIntervalMs, timeoutMs - elapsed);
    if (!signal) {
      await delay(waitMs);
      continue;
    }
    try {
      await delay(waitMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) throw previewClosedError(error);
      throw error;
    }
  }
}

/** ADB 子命令的静默结果；失败时保留 stdout/stderr 与错误码供上层分支。 */
interface QuietExecResult {
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

function readExecOutput(value: unknown): string {
  const output = (value as { stdout?: unknown } | null)?.stdout;
  return typeof output === 'string' ? output : '';
}

function readExecErrorOutput(value: unknown): string {
  const output = (value as { stderr?: unknown } | null)?.stderr;
  return typeof output === 'string' ? output : '';
}

async function execFileQuiet(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<QuietExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000, ...options });
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
      stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8')
    };
  } catch (error) {
    const failure = (error instanceof Error ? error : new Error(String(error))) as Error & { code?: string };
    const code = readErrorCode(error);
    if (code) failure.code = code;
    return { stdout: readExecOutput(error), stderr: readExecErrorOutput(error), error: failure };
  }
}

export function parseAdbDeviceState(devicesOutput: unknown, address: string): string | null {
  for (const line of String(devicesOutput || '').split(/\r?\n/)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial === address) return state || null;
  }
  return null;
}

async function readAdbDeviceState(address: string, adbPath: string): Promise<string | null> {
  const { stdout, error } = await execFileQuiet(adbPath, ['devices'], { timeout: 5000 });
  if (error) {
    throw createWebrtcError(`无法执行 ADB：${error.message}`, error.code === 'ENOENT' ? 'WEBRTC_ADB_NOT_FOUND' : 'WEBRTC_ADB_COMMAND_FAILED', {
      retryable: error.code !== 'ENOENT'
    });
  }
  return parseAdbDeviceState(stdout, address);
}

export interface WaitForAdbDeviceReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  getDeviceState?: () => string | null | Promise<string | null>;
  signal?: AbortSignal | null;
}

export async function waitForAdbDeviceReady(
  address: string,
  adbPath: string,
  {
    timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
    pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
    getDeviceState = () => readAdbDeviceState(address, adbPath),
    signal = null
  }: WaitForAdbDeviceReadyOptions = {}
): Promise<'device'> {
  let lastState: string | null = null;
  try {
    return await waitForCondition(async () => {
      lastState = await getDeviceState();
      return lastState === 'device' ? 'device' as const : false;
    }, {
      timeoutMs,
      pollIntervalMs,
      signal,
      timeoutMessage: `等待 ADB 设备就绪超时（${timeoutMs}ms）：${address}`,
      timeoutCode: 'WEBRTC_ADB_READY_TIMEOUT'
    });
  } catch (error) {
    if (readErrorCode(error) !== 'WEBRTC_ADB_READY_TIMEOUT') throw error;

    const stateMessages: Record<string, string> = {
      offline: `ADB 设备离线：${address}`,
      unauthorized: `ADB 设备未授权：${address}，请在设备上允许调试`,
      no_permissions: `ADB 无权访问设备：${address}`
    };
    const readinessError = createWebrtcError(
      (lastState && stateMessages[lastState]) || `ADB 中未找到目标设备：${address}`,
      lastState === 'offline'
        ? 'WEBRTC_ADB_DEVICE_OFFLINE'
        : lastState === 'unauthorized'
          ? 'WEBRTC_ADB_DEVICE_UNAUTHORIZED'
          : lastState === 'no_permissions'
            ? 'WEBRTC_ADB_DEVICE_FORBIDDEN'
            : 'WEBRTC_ADB_DEVICE_NOT_FOUND',
      { retryable: true, cause: error }
    );
    throw readinessError;
  }
}

async function getListeningPidsOnTcpPort(port: number): Promise<string[]> {
  const { stdout } = await execFileQuiet('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

async function isProcessListeningOnTcpPort(port: number): Promise<boolean> {
  return (await getListeningPidsOnTcpPort(port)).length > 0;
}

export async function pathExists(filePath: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getWebrtcBinaryPath(): Promise<string> {
  return getWebrtcRuntimeBinary(WEBRTC_DIR);
}

export async function getWebrtcAssetsPath(): Promise<string | null> {
  const legacyAssetsPath = path.join(WEBRTC_DIR, 'assets', 'v1');
  if (await pathExists(legacyAssetsPath)) return legacyAssetsPath;

  const releaseAssetsPath = path.join(WEBRTC_DIR, 'assets');
  if (await pathExists(path.join(releaseAssetsPath, 'index.html'))) return releaseAssetsPath;

  return null;
}

export async function getWebrtcLogPaths(): Promise<WebrtcLogPaths> {
  return {
    serverLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-server.log'),
    agentLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-agent.log'),
    turnLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-turn.log')
  };
}

export async function isWebrtcServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}`, {
      signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function requestWebrtcAuthToken(): Promise<string> {
  // 网关与上游使用同一组账号；凭据入口只解析环境，不生成或轮换密码。
  const { username, password } = resolveWebrtcCredentials();
  const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`WebRTC 登录失败（HTTP ${response.status}）`);
  }
  const data: unknown = await response.json();
  const token = isRecord(data) ? data.token : undefined;
  if (typeof token !== 'string' || token === '') throw new Error('WebRTC 登录响应缺少 token');
  return token;
}

export async function getWebrtcAuthToken({ throwOnError = false }: { throwOnError?: boolean } = {}): Promise<string> {
  try {
    return await requestWebrtcAuthToken();
  } catch (error) {
    if (throwOnError) throw error;
    return '';
  }
}

/** 从上游设备条目读取设备标识；字符串条目与 `device_id`/`id` 对象条目都兼容。 */
function parseWebrtcDeviceId(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (!isRecord(value)) return null;
  for (const key of ['device_id', 'id']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return null;
}

function normalizeDeviceIds(data: unknown): string[] {
  if (!Array.isArray(data)) throw new Error('WebRTC /devices 响应格式无效');
  const deviceIds: string[] = [];
  for (const item of data) {
    const deviceId = parseWebrtcDeviceId(item);
    if (deviceId) deviceIds.push(deviceId);
  }
  return deviceIds;
}

async function requestWebrtcDeviceDetails(): Promise<unknown[]> {
  const token = await requestWebrtcAuthToken();
  const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`WebRTC 设备列表请求失败（HTTP ${response.status}）`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error('WebRTC /devices 响应格式无效');
  return data;
}

export async function getWebrtcDevices({ throwOnError = false }: { throwOnError?: boolean } = {}): Promise<string[]> {
  try {
    return normalizeDeviceIds(await requestWebrtcDeviceDetails());
  } catch (error) {
    if (throwOnError) throw error;
    return [];
  }
}

export interface WaitForWebrtcServerReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  isReachable?: () => boolean | Promise<boolean>;
  childProcess?: WebrtcProcessState | null;
  signal?: AbortSignal | null;
}

export async function waitForWebrtcServerReady({
  timeoutMs = WEBRTC_SERVER_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  isReachable = isWebrtcServerReachable,
  childProcess = null,
  signal = null
}: WaitForWebrtcServerReadyOptions = {}): Promise<boolean> {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'WebRTC 服务');
    if (failure) throw failure;
    return isReachable();
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC 服务启动超时（${timeoutMs}ms）：http://127.0.0.1:${WEBRTC_PORT} 未就绪`,
    timeoutCode: 'WEBRTC_SERVER_START_TIMEOUT'
  });
}

export interface WaitForTurnServerReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  isListening?: () => boolean | Promise<boolean>;
  childProcess?: WebrtcProcessState | null;
  signal?: AbortSignal | null;
}

export async function waitForTurnServerReady({
  timeoutMs = WEBRTC_TURN_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  isListening = () => isProcessListeningOnTcpPort(WEBRTC_TURN_PORT),
  childProcess = null,
  signal = null
}: WaitForTurnServerReadyOptions = {}): Promise<boolean> {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'TURN 服务');
    if (failure) throw failure;
    return isListening();
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `TURN 服务启动超时（${timeoutMs}ms）：127.0.0.1:${WEBRTC_TURN_PORT} 未监听`,
    timeoutCode: 'WEBRTC_TURN_START_TIMEOUT'
  });
}

async function waitForWebrtcDevicesApi({
  timeoutMs = WEBRTC_SERVER_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  signal = null
}: Omit<WaitForWebrtcServerReadyOptions, 'isReachable' | 'childProcess'> = {}): Promise<string[]> {
  const result = await waitForCondition(async () => ({
    devices: await getWebrtcDevices({ throwOnError: true })
  }), {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC 鉴权设备接口启动超时（${timeoutMs}ms）：/devices 未就绪`,
    timeoutCode: 'WEBRTC_DEVICES_API_TIMEOUT'
  });
  return result.devices;
}

export interface WaitForWebrtcDeviceOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  getDevices?: () => string[] | Promise<string[]>;
  childProcess?: WebrtcProcessState | null;
  isAgentRunning?: (() => boolean | Promise<boolean>) | null;
  signal?: AbortSignal | null;
}

export async function waitForWebrtcDevice(
  deviceId: string,
  {
    timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
    pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
    getDevices = () => getWebrtcDevices({ throwOnError: true }),
    childProcess = null,
    isAgentRunning = null,
    signal = null
  }: WaitForWebrtcDeviceOptions = {}
): Promise<string[]> {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'WebRTC Agent 部署', { allowSuccessfulExit: true });
    if (failure) throw failure;
    if (childProcess && childProcess.exitCode !== 0) return false;
    if (childProcess?.exitCode === 0 && isAgentRunning && !await isAgentRunning()) {
      throw createWebrtcError('WebRTC Agent 部署脚本已结束，但设备端进程未启动', 'WEBRTC_AGENT_DEPLOYMENT_FAILED', {
        retryable: true
      });
    }
    const devices = await getDevices();
    if (!devices.includes(deviceId)) return false;
    if (isAgentRunning && !await isAgentRunning()) return false;
    return devices;
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC Agent 启动超时（${timeoutMs}ms）：设备 ${deviceId} 未出现在鉴权 /devices 列表中`,
    timeoutCode: 'WEBRTC_AGENT_START_TIMEOUT'
  });
}

async function waitForWebrtcDeviceUnavailable(
  deviceId: string,
  {
    timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
    pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
    signal = null
  }: Omit<WaitForWebrtcDeviceOptions, 'getDevices' | 'childProcess' | 'isAgentRunning'> = {}
): Promise<string[]> {
  return waitForCondition(async () => {
    const devices = await getWebrtcDevices({ throwOnError: true });
    return devices.includes(deviceId) ? false : devices;
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC Agent 停止超时（${timeoutMs}ms）：设备 ${deviceId} 仍在鉴权 /devices 列表中`,
    timeoutCode: 'WEBRTC_AGENT_STOP_TIMEOUT'
  });
}

async function isDeviceAgentRunning(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'ps -A | grep cloudphone-agent || true'], { timeout: 5000 });
    return stdout.includes('cloudphone-agent');
  } catch {
    return false;
  }
}

async function getIceServersConfig(address = DEFAULT_DEVICE_ADDRESS, turnListening?: boolean): Promise<string> {
  if (process.env.LA_PLUMA_WEBRTC_ICE_SERVERS !== undefined) return process.env.LA_PLUMA_WEBRTC_ICE_SERVERS;
  if (!(turnListening ?? await isProcessListeningOnTcpPort(WEBRTC_TURN_PORT))) return '';
  const lanIp = getWebrtcHostIp(address);
  return `turn:cloudphone_user:cloudphone_secure_password@${lanIp}:${WEBRTC_TURN_PORT}?transport=udp,stun:${lanIp}:${WEBRTC_TURN_PORT}`;
}

function isSameAgentOwner(owner: WebrtcAgentOwner | null, address: string, deviceId: string): boolean {
  return owner?.address === address && owner?.deviceId === deviceId;
}

async function stopRemoteWebrtcAgent(
  address: string,
  adbPath: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<void> {
  const killRemote = (command: string) => execFileAsync(adbPath, ['-s', address, 'shell', command], {
    timeout: 5000,
    signal
  }).catch(() => {});
  await killRemote('pkill -f cloudphone-agent || true');
  await killRemote('pkill -f com.android.helper.CoreService || true');
  await killRemote('pkill -f scrcpy.Server || true');
}

async function startLocalTurnServerUnlocked(): Promise<void> {
  const signal = getCloseSignal();
  assertPreviewOpen();
  if (await isProcessListeningOnTcpPort(WEBRTC_TURN_PORT)) return;
  let child = isChildProcessRunning(webrtcTurnProcess) ? webrtcTurnProcess : null;
  if (!child) {
    const configuredTurnServer = process.env.LA_PLUMA_WEBRTC_TURN_SERVER_PATH?.trim();
    const turnserver = configuredTurnServer
      ? [configuredTurnServer]
      : ['/usr/bin/turnserver', '/usr/local/bin/turnserver', '/opt/homebrew/bin/turnserver'];
    let turnserverPath: string | null = null;
    for (const candidate of turnserver) {
      if (await pathExists(candidate)) {
        turnserverPath = candidate;
        break;
      }
    }
    if (!turnserverPath) return;
    const { turnLog } = await getWebrtcLogPaths();
    assertPreviewOpen();
    child = spawnWithLog(turnserverPath, [
      '-n',
      '--no-cli',
      '--no-tls',
      '--no-dtls',
      '-L', '0.0.0.0',
      '-p', String(WEBRTC_TURN_PORT),
      '-a',
      '-u', 'cloudphone_user:cloudphone_secure_password',
      '-r', 'cloudphone'
    ], turnLog, {
      cwd: WEBRTC_DIR,
      detached: false
    });
    webrtcTurnProcess = trackManagedProcess(child, 'turn');
  }
  try {
    await waitForTurnServerReady({ childProcess: child, signal });
  } catch (error) {
    if (isChildProcessRunning(child)) child.kill('SIGTERM');
    clearManagedProcess('turn', child);
    throw error;
  }
}

function terminateOwnedLocalProcesses(): ChildProcess[] {
  const children = [webrtcBuildProcess, webrtcAgentProcess, webrtcServerProcess, webrtcTurnProcess]
    .filter((child): child is ChildProcess => child !== null);
  terminateManagedProcess(webrtcBuildProcess);
  terminateManagedProcess(webrtcAgentProcess);
  terminateManagedProcess(webrtcServerProcess);
  terminateManagedProcess(webrtcTurnProcess);
  webrtcBuildProcess = null;
  webrtcAgentProcess = null;
  webrtcServerProcess = null;
  webrtcTurnProcess = null;
  return children;
}

/**
 * 托管子进程的强制收尾：SIGTERM 的生效依赖子进程及其进程组的信号处理时机，
 * 高负载下可能不生效或显著延迟。宽限期内仍存活的子进程以 SIGKILL 结束，
 * 保证停止与关闭流程不遗留本实例启动的进程。
 */
async function enforceOwnedProcessesTerminated(children: readonly ChildProcess[]): Promise<void> {
  const deadline = Date.now() + WEBRTC_PROCESS_KILL_GRACE_MS;
  while (Date.now() < deadline && children.some(isChildProcessRunning)) {
    await delay(20);
  }
  for (const child of children) {
    if (isChildProcessRunning(child)) terminateManagedProcess(child, 'SIGKILL');
  }
}

/**
 * 只释放本实例启动的预览资源：本进程的本地子进程，以及登记了所有权的设备端 Agent。
 * 启动前已存在的 server/TURN 与设备端 Agent 没有所有权记录，保持不动。
 */
async function releaseOwnedPreviewResourcesUnlocked(
  { stopDeviceAgent = false }: { stopDeviceAgent?: boolean } = {}
): Promise<WebrtcReleasedResource[]> {
  const owner = registeredAgentOwner;
  const released: WebrtcReleasedResource[] = [];
  idleStoppedAgentOwner = null;
  if (owner) viewerLifecycle.stopped(owner.deviceId);
  if (isChildProcessRunning(webrtcAgentProcess)) released.push('agent-deployment');
  if (isChildProcessRunning(webrtcServerProcess)) released.push('server');
  if (isChildProcessRunning(webrtcTurnProcess)) released.push('turn');
  await enforceOwnedProcessesTerminated(terminateOwnedLocalProcesses());
  registeredAgentOwner = null;
  if (stopDeviceAgent && owner) {
    await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() });
    released.push('device-agent');
  }
  return released;
}

export async function getWebrtcStatus(
  address = DEFAULT_DEVICE_ADDRESS,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcStatus> {
  const binaryPath = await getWebrtcBinaryPath();
  const assetsPath = await getWebrtcAssetsPath();
  const lanIp = getWebrtcHostIp(address);
  const logPaths = await getWebrtcLogPaths();
  const [serverReachable, turnListening, deviceAgentRunning] = await Promise.all([
    isWebrtcServerReachable(),
    isProcessListeningOnTcpPort(WEBRTC_TURN_PORT),
    isDeviceAgentRunning(address, adbPath)
  ]);
  const serverManaged = isChildProcessRunning(webrtcServerProcess);
  const turnManaged = isChildProcessRunning(webrtcTurnProcess);
  const agentRunning = isChildProcessRunning(webrtcAgentProcess) || deviceAgentRunning;
  const agentManaged = Boolean(registeredAgentOwner) && registeredAgentOwner?.address === address;
  return {
    installed: await pathExists(WEBRTC_DIR),
    built: await pathExists(binaryPath) && assetsPath !== null,
    dir: WEBRTC_DIR,
    port: WEBRTC_PORT,
    url: `http://127.0.0.1:${WEBRTC_PORT}`,
    lanUrl: `http://${lanIp}:${WEBRTC_PORT}`,
    signalingUrl: '/webrtc-signaling',
    directSignalingUrl: `ws://${lanIp}:${WEBRTC_PORT}`,
    turnRunning: turnManaged,
    iceServers: await getIceServersConfig(address, turnListening),
    serverRunning: serverManaged || serverReachable,
    agentRunning,
    // 所有权与“是否运行”分开：managed 由本实例启动/登记，external 是启动前已存在或其它实例的资源。
    ownership: {
      server: serverManaged ? 'managed' : (serverReachable ? 'external' : 'none'),
      turn: turnManaged ? 'managed' : (turnListening ? 'external' : 'none'),
      agent: agentManaged && agentRunning ? 'managed' : (agentRunning ? 'external' : 'none')
    },
    deviceAddress: address,
    ...logPaths
  };
}

async function installWebrtcUnlocked(): Promise<WebrtcStatus> {
  const signal = getCloseSignal();
  assertPreviewOpen();
  const fs = await import('node:fs/promises');

  const binaryPath = await getWebrtcBinaryPath();
  const assetsPath = await getWebrtcAssetsPath();
  if (await pathExists(binaryPath) && assetsPath && await pathExists(path.join(WEBRTC_DIR, 'agentd', 'run.sh'))) {
    return getWebrtcStatus();
  }

  const buildScript = path.join(WEBRTC_DIR, 'build.sh');
  if (!await pathExists(buildScript)) {
    try {
      await installWebrtcRelease(WEBRTC_DIR, { signal });
    } catch (error) {
      if (signal.aborted) throw previewClosedError(error);
      throw error;
    }
    const status = await getWebrtcStatus();
    if (!status.built) throw new Error('WebRTC 发布包安装完成，但运行资源不完整');
    return status;
  }

  await fs.chmod(buildScript, 0o755);
  assertPreviewOpen();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [buildScript], { cwd: WEBRTC_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    webrtcBuildProcess = child;
    const abortBuild = () => terminateManagedProcess(child);
    // 关闭流程会终止本实例启动的构建子进程，避免它成为无人回收的孤儿。
    signal.addEventListener('abort', abortBuild, { once: true });
    const finish = () => {
      signal.removeEventListener('abort', abortBuild);
      if (webrtcBuildProcess === child) webrtcBuildProcess = null;
    };
    const appendOutput = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-4000);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('close', code => {
      finish();
      if (signal.aborted) {
        reject(previewClosedError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.trim();
      const error = createWebrtcError(`build.sh 失败（退出码 ${code}）${detail ? `：${detail}` : ''}`, 'WEBRTC_BUILD_FAILED', {
        retryable: false
      });
      error.exitCode = code;
      reject(error);
    });
    child.on('error', error => {
      finish();
      reject(signal.aborted ? previewClosedError(error) : error);
    });
  });

  const status = await getWebrtcStatus();
  if (!status.built) {
    throw createWebrtcError('build.sh 已完成，但未找到 WebRTC 可执行文件或静态资源', 'WEBRTC_BUILD_OUTPUT_MISSING', {
      retryable: false
    });
  }
  return status;
}

export async function installWebrtc(): Promise<WebrtcStatus> {
  return enqueueLifecycle(installWebrtcUnlocked);
}

async function startWebrtcServerUnlocked(address: string, adbPath: string): Promise<WebrtcStatus> {
  const signal = getCloseSignal();
  assertPreviewOpen();
  if (await isWebrtcServerReachable()) {
    return getWebrtcStatus(address, adbPath);
  }
  assertPreviewOpen();

  let child = webrtcServerProcess;
  let spawned = false;
  if (!isChildProcessRunning(child)) {
    const binaryPath = await getWebrtcBinaryPath();
    const assetsPath = await getWebrtcAssetsPath();
    if (!await pathExists(binaryPath) || !assetsPath) {
      throw new Error('WebRTC 组件未安装或未构建');
    }

    await startLocalTurnServerUnlocked();
    const { serverLog } = await getWebrtcLogPaths();
    const iceServers = await getIceServersConfig(address);
    assertPreviewOpen();
    child = spawnWithLog(binaryPath, ['-host', '0.0.0.0', '-port', String(WEBRTC_PORT), '-assets', assetsPath, '-ice_servers', iceServers, '-tls=false'], serverLog, {
      cwd: WEBRTC_DIR,
      detached: false,
      env: { ...process.env, PORT: String(WEBRTC_PORT), PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }
    });
    webrtcServerProcess = trackManagedProcess(child, 'server');
    spawned = true;
  }

  try {
    await waitForWebrtcServerReady({ childProcess: child, signal });
  } catch (error) {
    if (spawned && isChildProcessRunning(child)) child.kill('SIGTERM');
    clearManagedProcess('server', child);
    throw error;
  }
  return getWebrtcStatus(address, adbPath);
}

export async function startWebrtcServer(
  address = DEFAULT_DEVICE_ADDRESS,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcStatus> {
  return enqueueLifecycle(() => startWebrtcServerUnlocked(address, adbPath));
}

async function stopWebrtcServerUnlocked(address: string, adbPath: string): Promise<WebrtcStopResult> {
  const released = await releaseOwnedPreviewResourcesUnlocked({ stopDeviceAgent: true });
  const status = await getWebrtcStatus(address, adbPath);
  return { ...status, released };
}

export async function stopWebrtcServer(
  address = DEFAULT_DEVICE_ADDRESS,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcStopResult> {
  return enqueueLifecycle(() => stopWebrtcServerUnlocked(address, adbPath));
}

async function startWebrtcAgentUnlocked(
  address: string,
  deviceId: string,
  adbPath: string
): Promise<WebrtcRunningStatus> {
  const signal = getCloseSignal();
  idleStoppedAgentOwner = null;
  assertPreviewOpen();
  await waitForWebrtcServerReady({ signal });
  const onlineDevices = await waitForWebrtcDevicesApi({ signal });
  const currentOwner = registeredAgentOwner;
  if (isSameAgentOwner(currentOwner, address, deviceId)
    && onlineDevices.includes(deviceId)
    && await isDeviceAgentRunning(address, adbPath)) {
    assertPreviewOpen();
    registeredAgentOwner = { address, deviceId, adbPath, generation: ++agentGeneration };
    viewerLifecycle.started(deviceId, registeredAgentOwner.generation);
    return { ...await getWebrtcStatus(address, adbPath), agentRunning: true };
  }

  if (/^[^:]+:\d+$/.test(address)) {
    assertPreviewOpen();
    await execFileQuiet(adbPath, ['connect', address], { timeout: 5000 });
  }
  await waitForAdbDeviceReady(address, adbPath, { signal });

  if (currentOwner) {
    registeredAgentOwner = null;
    viewerLifecycle.stopped(currentOwner.deviceId);
    await stopRemoteWebrtcAgent(currentOwner.address, currentOwner.adbPath, { signal });
    await waitForWebrtcDeviceUnavailable(currentOwner.deviceId, { signal });
  }

  const runScript = path.join(WEBRTC_DIR, 'agentd', 'run.sh');
  if (!await pathExists(runScript)) {
    throw new Error('WebRTC agent 未安装');
  }

  const { agentLog } = await getWebrtcLogPaths();
  const lanIp = getWebrtcHostIp(address);
  const iceServers = await getIceServersConfig(address);
  assertPreviewOpen();
  const child = spawnWithLog('bash', [runScript, address, '-id', deviceId, '-signaling', `ws://${lanIp}:${WEBRTC_PORT}`, '-ice-servers', iceServers, '-webrtc-port', '50000'], agentLog, {
    cwd: path.join(WEBRTC_DIR, 'agentd'),
    detached: true,
    env: { ...process.env, ADB_PATH: adbPath, PATH: `${path.dirname(adbPath)}:${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
  });
  webrtcAgentProcess = trackManagedProcess(child, 'agent');
  try {
    await waitForWebrtcDevice(deviceId, {
      childProcess: child,
      isAgentRunning: () => isDeviceAgentRunning(address, adbPath),
      signal
    });
    registeredAgentOwner = { address, deviceId, adbPath, generation: ++agentGeneration };
    viewerLifecycle.started(deviceId, registeredAgentOwner.generation);
    return { ...await getWebrtcStatus(address, adbPath), agentRunning: true };
  } catch (error) {
    terminateManagedProcess(child);
    clearManagedProcess('agent', child);
    if (isSameAgentOwner(registeredAgentOwner, address, deviceId)) registeredAgentOwner = null;
    await stopRemoteWebrtcAgent(address, adbPath, { signal });
    throw error;
  }
}

export async function startWebrtcAgent(
  address = DEFAULT_DEVICE_ADDRESS,
  deviceId = DEFAULT_DEVICE_ID,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcRunningStatus> {
  return enqueueLifecycle(() => startWebrtcAgentUnlocked(address, deviceId, adbPath));
}

async function stopWebrtcAgentUnlocked(address: string, adbPath: string): Promise<WebrtcStopResult> {
  const owner = registeredAgentOwner;
  const released: WebrtcReleasedResource[] = [];
  idleStoppedAgentOwner = null;
  if (owner) viewerLifecycle.stopped(owner.deviceId);
  if (isChildProcessRunning(webrtcAgentProcess)) released.push('agent-deployment');
  terminateManagedProcess(webrtcAgentProcess);
  webrtcAgentProcess = null;
  registeredAgentOwner = null;
  if (owner) {
    await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() });
    released.push('device-agent');
  }
  const status = await getWebrtcStatus(address, adbPath);
  return { ...status, released };
}

export async function stopWebrtcAgent(
  address = DEFAULT_DEVICE_ADDRESS,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcStopResult> {
  return enqueueLifecycle(() => stopWebrtcAgentUnlocked(address, adbPath));
}

/** 把上游设备条目收窄为设备标识与观看者计数；未知或缺失字段按 0/无观看者处理。 */
function parseWebrtcDeviceDetails(entry: unknown): WebrtcDeviceDetails | null {
  if (!isRecord(entry)) return null;
  const deviceId = parseWebrtcDeviceId(entry);
  if (!deviceId) return null;
  const rawCount = entry.client_count;
  const parsedCount = typeof rawCount === 'number'
    ? rawCount
    : typeof rawCount === 'string' && rawCount.trim() !== ''
      ? Number(rawCount)
      : 0;
  const clients = entry.clients;
  return {
    deviceId,
    clientCount: Number.isFinite(parsedCount) ? parsedCount : 0,
    hasClients: Array.isArray(clients) && clients.length > 0
  };
}

async function stopIdleWebrtcAgentUnlocked(
  deviceId: string,
  generation: number,
  isIdle: () => boolean
): Promise<WebrtcIdleReleaseResult | undefined> {
  const owner = registeredAgentOwner;
  if (!owner || owner.deviceId !== deviceId || owner.generation !== generation || !isIdle()) return;

  // The upstream service also knows about viewers connected directly to its
  // listener. Older releases return string IDs only; those use gateway counts.
  const devices = await requestWebrtcDeviceDetails();
  const device = devices
    .map(parseWebrtcDeviceDetails)
    .find(entry => entry !== null && entry.deviceId === deviceId);
  if (device && (device.clientCount > 0 || device.hasClients)) return { retry: true };
  if (!isIdle() || registeredAgentOwner !== owner) return;

  terminateManagedProcess(webrtcAgentProcess);
  webrtcAgentProcess = null;
  await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() });
  if (registeredAgentOwner === owner) registeredAgentOwner = null;
  idleStoppedAgentOwner = owner;
  viewerLifecycle.stopped(deviceId);
  return { stopped: true };
}

async function closeWebrtcPreview(): Promise<{ stopped: true }> {
  closeRequested = true;
  if (!closeAbort.signal.aborted) closeAbort.abort();
  // 先取消 viewer 自动回收计时器，再终止本进程拥有的子进程；
  // 已受理的启动/停止会因 abort 立即结束，等待队列后做一次兜底终止。
  viewerLifecycle.close();
  const childrenAtClose = terminateOwnedLocalProcesses();
  await webrtcLifecycleQueue;
  const childrenAfterQueue = terminateOwnedLocalProcesses();
  await enforceOwnedProcessesTerminated([...childrenAtClose, ...childrenAfterQueue]);
  idleStoppedAgentOwner = null;
  registeredAgentOwner = null;
  return { stopped: true };
}

/**
 * 把预览资源释放注册到运行时关闭流程；同一 lifecycle 只注册一次。
 *
 * 关闭只处理本实例启动或登记所有权的资源：viewer 计时器/会话、
 * 本进程的信号服务/TURN/Agent 部署/构建子进程。启动前已存在的
 * server/TURN 与设备端 Agent 没有所有权记录，不在此流程内。
 */
export function attachWebrtcPreviewToLifecycle(
  lifecycle: WebrtcPreviewLifecycle | null | undefined
): { attached: boolean; duplicate: boolean } {
  if (!lifecycle || typeof lifecycle.register !== 'function') {
    return { attached: false, duplicate: false };
  }
  if (attachedLifecycles.has(lifecycle)) {
    return { attached: true, duplicate: true };
  }
  lifecycle.register({
    name: 'webrtc-preview',
    close: () => closeWebrtcPreview()
  });
  attachedLifecycles.add(lifecycle);
  attachedLifecycle = lifecycle;
  return { attached: true, duplicate: false };
}

export async function startWebrtc(
  address = DEFAULT_DEVICE_ADDRESS,
  deviceId = DEFAULT_DEVICE_ID,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcRunningStatus> {
  return enqueueLifecycle(async () => {
    await startWebrtcServerUnlocked(address, adbPath);
    return startWebrtcAgentUnlocked(address, deviceId, adbPath);
  });
}

export async function stopWebrtc(
  address = DEFAULT_DEVICE_ADDRESS,
  adbPath = DEFAULT_ADB_PATH
): Promise<WebrtcStopSummary> {
  return enqueueLifecycle(async () => {
    const released: WebrtcReleasedResource[] = [];
    const agentResult = await stopWebrtcAgentUnlocked(address, adbPath).catch(() => null);
    if (agentResult?.released) released.push(...agentResult.released);
    const serverResult = await stopWebrtcServerUnlocked(address, adbPath).catch(() => null);
    if (serverResult?.released) released.push(...serverResult.released);
    return { stopped: true, released: [...new Set(released)] };
  });
}
