import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../utils/logger.ts';
import { acquireMaaExecutionLease } from './executionCoordinatorService.ts';
import type { MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import { addLog, execMaaCommandUnlocked } from './maaProcessService.ts';
import type {
  MaaBackgroundStart,
  MaaCommandError,
  MaaCommandOutput,
  MaaCommandOutcome,
  MaaProcessLifecycle,
  MaaProcessPorts,
  MaaSettledHandler
} from './maaProcessService.ts';
import { getMaaConfigDir } from './maaConfigService.ts';
import { resolveConnection } from './connectionService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { createMaaLogCheckpoint, readMaaLogSince } from './maaLogFileService.ts';
import type { MaaLogCheckpoint } from './maaLogFileService.ts';
import { parseGameTaskExecutionAction, readOperProgressPlans } from './gameTaskResultService.ts';
import type { GameTaskExecutionAction, GameTaskType } from './gameTaskResultService.ts';
import { normalizeGameTaskParams, validateGameTaskParams, validateRoguelikeCommandArgs } from './gameTaskConfigService.ts';
import { agentError } from '../utils/apiHelper.ts';

const logger = createLogger('MaaService');

const DEVICE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'startup', 'closedown', 'fight', 'run', 'copilot', 'ssscopilot', 'paradoxcopilot',
  'roguelike', 'reclamation', 'infrast', 'recruit', 'mall', 'award', 'depot', 'operbox',
  'install', 'update', 'hot-update'
]);

export interface MaaVersionInfo {
  raw: string;
  cli: string;
  core: string;
}

/** 执行入口只需要释放能力；完整租约元数据仍归 executionCoordinatorService。 */
export interface MaaExecutionLeaseHandle {
  release(): Promise<void>;
}

export type MaaExecutionLeaseAcquirer = (
  request: MaaExecutionLeaseRequest
) => Promise<MaaExecutionLeaseHandle>;

/** maa-cli 在上游 variants 匹配时的参数合并策略；默认 first。 */
export type MaaDynamicTaskStrategy = 'first' | 'merge';

/** 上游 variants 项：condition 决定是否匹配，匹配后的 params 合并进任务参数。 */
export interface MaaDynamicTaskVariant {
  condition?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface MaaDynamicTaskConfig {
  name: string;
  type: string;
  params?: Record<string, unknown>;
  strategy?: MaaDynamicTaskStrategy;
  variants?: MaaDynamicTaskVariant[];
}

export const MAA_DYNAMIC_TASK_DIR_PREFIX = 'la-pluma-task-';
export const MAA_DYNAMIC_TASK_OWNER_FILE = 'owner.json';
export const MAA_DYNAMIC_TASK_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS = 4096;

export interface MaaDynamicTaskCleanupSummary {
  scanned: number;
  removed: number;
  retained: number;
}

export interface MaaDynamicTaskCleanupOptions {
  getConfigDir?: () => Promise<string>;
  now?: () => number;
  expiryMs?: number;
}

/** 动态任务执行端口；签名与 execMaaCommandUnlocked 的实现契约一致。 */
export type MaaDynamicTaskExecutor = (
  command: string,
  args: readonly string[],
  taskName: string | null,
  taskType: string | null,
  waitForCompletion: boolean,
  silent: boolean,
  onSettled: MaaSettledHandler | null,
  lifecycle: MaaProcessLifecycle,
  ports?: MaaProcessPorts
) => Promise<MaaCommandOutput | MaaBackgroundStart>;

export interface MaaDynamicTaskRuntime {
  acquireExecutionLease?: MaaExecutionLeaseAcquirer;
  getConfigDir?: () => Promise<string>;
  mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, content: string, encoding: 'utf-8') => Promise<unknown>;
  removeDirectory?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<unknown>;
  executeCommand?: MaaDynamicTaskExecutor;
  createNonce?: () => string;
  resolveClientType?: () => Promise<string>;
  /** 覆盖连接 profile 的客户端类型；空白值按未提供处理，startup 动态任务沿用任务自身的客户端选择。 */
  clientType?: string;
  lifecycle?: MaaProcessLifecycle;
  createLogCheckpoint?: () => Promise<MaaLogCheckpoint | null>;
  readLogSince?: (checkpoint: MaaLogCheckpoint | null) => Promise<string>;
}

export interface MaaDynamicTaskOutput extends MaaCommandOutput {
  actions?: GameTaskExecutionAction[];
}

/** 多任务结果按 tasks 索引归档；pending 只出现在停止后的未开始任务。 */
export type MaaDynamicTaskStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped';

export interface MaaDynamicTaskStep extends MaaDynamicTaskConfig {
  index: number;
  status: MaaDynamicTaskStepStatus;
  message: string;
  stdout: string;
  stderr: string;
  actions?: GameTaskExecutionAction[];
}

/** 聚合失败详情中的逐项结果：stdout/stderr 有界，完整输出只保留在 result.tasks。 */
export interface MaaDynamicTaskErrorStep extends MaaDynamicTaskStep {
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface MaaDynamicTasksOutput extends MaaCommandOutput {
  stopped: boolean;
  tasks: MaaDynamicTaskStep[];
  actions?: GameTaskExecutionAction[];
  message?: string;
}

export interface MaaDynamicTasksBackgroundStart extends MaaBackgroundStart {
  stopped: boolean;
  tasks: MaaDynamicTaskStep[];
  actions?: GameTaskExecutionAction[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorFields(error: unknown, message: string): MaaCommandError {
  const fields: Record<string, unknown> = isRecord(error) ? error : {};
  const result: MaaCommandError = new Error(message, { cause: error });
  result.code = typeof fields.code === 'string' || typeof fields.code === 'number' || fields.code === null
    ? fields.code
    : undefined;
  result.statusCode = typeof fields.statusCode === 'number' || fields.statusCode === null
    ? fields.statusCode
    : undefined;
  result.details = fields.details;
  result.retryable = typeof fields.retryable === 'boolean' ? fields.retryable : undefined;
  result.exitCode = typeof fields.exitCode === 'number' || fields.exitCode === null
    ? fields.exitCode
    : undefined;
  result.signal = typeof fields.signal === 'string' || fields.signal === null
    ? fields.signal
    : undefined;
  result.stopped = typeof fields.stopped === 'boolean' ? fields.stopped : undefined;
  result.stdout = typeof fields.stdout === 'string' ? fields.stdout : undefined;
  result.stderr = typeof fields.stderr === 'string' ? fields.stderr : undefined;
  return result;
}

export function requiresMaaExecutionLease(command: string): boolean {
  return DEVICE_MUTATING_COMMANDS.has(command);
}

/**
 * 执行需要设备变更权的 MAA 命令。
 * 取得租约后先过 onBeforeStart 门禁再 spawn；后台执行的租约只在子进程
 * 实际退出（onSettled）后释放，HTTP 接受响应不触发释放。
 */
export function execMaaCommand(
  command: string,
  args?: readonly string[],
  taskName?: null,
  taskType?: string | null,
  waitForCompletion?: boolean,
  silent?: boolean,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommand(
  command: string,
  args: readonly string[] | undefined,
  taskName: string | null | undefined,
  taskType: string | null | undefined,
  waitForCompletion: true,
  silent?: boolean,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommand(
  command: string,
  args: readonly string[] | undefined,
  taskName: string,
  taskType: string | null | undefined,
  waitForCompletion: false,
  silent?: boolean,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaBackgroundStart>;
export function execMaaCommand(
  command: string,
  args: readonly string[] | undefined,
  taskName: string,
  taskType: string | null | undefined,
  waitForCompletion: true,
  silent?: boolean,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput>;
export function execMaaCommand(
  command: string,
  args?: readonly string[],
  taskName?: string | null,
  taskType?: string | null,
  waitForCompletion?: boolean,
  silent?: boolean,
  lifecycle?: MaaProcessLifecycle,
  ports?: MaaProcessPorts
): Promise<MaaCommandOutput | MaaBackgroundStart>;
export async function execMaaCommand(
  command: string,
  args: readonly string[] = [],
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion = false,
  silent = false,
  lifecycle: MaaProcessLifecycle = {},
  ports: MaaProcessPorts = {}
): Promise<MaaCommandOutput | MaaBackgroundStart> {
  const commandArgsError = validateRoguelikeCommandArgs(command, args);
  if (commandArgsError) {
    throw agentError('AGENT_VALIDATION_TASK_ARGS_INVALID', commandArgsError, { statusCode: 400, retryable: false });
  }
  if (!requiresMaaExecutionLease(command)) {
    return execMaaCommandUnlocked(command, args, taskName, taskType, waitForCompletion, silent, null, lifecycle, ports);
  }

  const lease = await acquireMaaExecutionLease({
    source: taskType || 'maa-command',
    taskName: taskName || command,
    command
  });
  let releaseOnReturn = true;
  try {
    if (taskName && !waitForCompletion) {
      const { onSettled: lifecycleOnSettled, ...processLifecycle } = lifecycle;
      const result = await execMaaCommandUnlocked(
        command,
        args,
        taskName,
        taskType,
        waitForCompletion,
        silent,
        async (outcome) => {
          try {
            await lease.release();
          } catch (error) {
            logger.error('释放 MAA 执行锁失败', { error: errorMessageOf(error) });
          }
          try {
            await lifecycleOnSettled?.(outcome);
          } catch (error) {
            logger.error('处理 MAA 后台任务终态失败', { error: errorMessageOf(error) });
          }
        },
        processLifecycle,
        ports
      );
      releaseOnReturn = false;
      return result;
    }
    return await execMaaCommandUnlocked(command, args, taskName, taskType, waitForCompletion, silent, null, lifecycle, ports);
  } finally {
    if (releaseOnReturn) await lease.release();
  }
}

export async function getMaaVersion(silent = false): Promise<MaaVersionInfo> {
  const result = await execMaaCommand('version', [], null, null, false, silent);
  const output = result.stdout;

  const lines = output.trim().split('\n');
  const versions: MaaVersionInfo = {
    raw: output,
    cli: '',
    core: ''
  };

  for (const line of lines) {
    if (line.startsWith('maa-cli')) {
      versions.cli = line.replace('maa-cli', '').trim();
    } else if (line.startsWith('MaaCore')) {
      versions.core = line.replace('MaaCore', '').trim();
    }
  }

  return versions;
}

function normalizeDynamicTaskVariants(value: unknown): MaaDynamicTaskVariant[] {
  if (!Array.isArray(value)) {
    throw new TypeError('动态任务的 variants 必须是数组');
  }
  return value.map(variant => {
    if (!isRecord(variant)) {
      throw new TypeError('动态任务的 variants 每一项都必须是对象');
    }
    const condition = variant.condition;
    if (condition !== undefined && !isRecord(condition)) {
      throw new TypeError('动态任务 variant.condition 必须是对象');
    }
    const params = variant.params;
    if (params !== undefined && !isRecord(params)) {
      throw new TypeError('动态任务 variant.params 必须是对象');
    }
    return {
      ...(condition ? { condition } : {}),
      ...(params ? { params } : {})
    };
  });
}

function normalizeDynamicTaskConfig(taskConfig: MaaDynamicTaskConfig | string): MaaDynamicTaskConfig {
  const parsed: unknown = typeof taskConfig === 'string' ? JSON.parse(taskConfig) : taskConfig;
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.type !== 'string') {
    throw new TypeError('动态任务配置必须包含 name 与 type');
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const strategy = parsed.strategy;
  if (strategy !== undefined && strategy !== 'first' && strategy !== 'merge') {
    throw new TypeError('动态任务 strategy 必须是 first 或 merge');
  }
  const variants = parsed.variants === undefined
    ? undefined
    : normalizeDynamicTaskVariants(parsed.variants);
  return {
    name: parsed.name,
    type: parsed.type,
    params,
    ...(strategy ? { strategy } : {}),
    ...(variants ? { variants } : {})
  };
}

function normalizeDynamicTaskParamAliases(config: MaaDynamicTaskConfig): MaaDynamicTaskConfig {
  const params = normalizeGameTaskParams(config.type, config.params ?? {});
  if (params.error) {
    throw agentError('AGENT_VALIDATION_TASK_CONFIG_INVALID', params.error, { statusCode: 400 });
  }
  const variants = config.variants?.map((variant, variantIndex) => {
    if (!variant.params) return variant;
    const variantParams = normalizeGameTaskParams(config.type, variant.params);
    if (variantParams.error) {
      throw agentError('AGENT_VALIDATION_TASK_CONFIG_INVALID', variantParams.error, {
        statusCode: 400,
        details: { variantIndex }
      });
    }
    return variantParams.params === variant.params
      ? variant
      : { ...variant, params: variantParams.params };
  });
  return {
    ...config,
    params: params.params,
    ...(variants ? { variants } : {})
  };
}

interface MaaDynamicTaskOwnerMarker {
  pid: number;
  startedAt: number;
}

function isLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

async function readDynamicTaskOwnerMarker(path: string): Promise<MaaDynamicTaskOwnerMarker | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const startedAt = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN;
  if (!Number.isInteger(parsed.pid) || !Number.isFinite(startedAt)) return null;
  return { pid: Number(parsed.pid), startedAt };
}

/**
 * 启动时回收上次进程遗留的动态任务目录。
 * 只有同时满足“持有进程已不存活”与“超过有效期”才删除；无法确认归属或状态的目录一律保留。
 */
export async function cleanupStaleDynamicTaskDirectories(
  options: MaaDynamicTaskCleanupOptions = {}
): Promise<MaaDynamicTaskCleanupSummary> {
  const resolveConfigDir = options.getConfigDir || getMaaConfigDir;
  const now = options.now ? options.now() : Date.now();
  const expiryMs = options.expiryMs ?? MAA_DYNAMIC_TASK_EXPIRY_MS;
  const tasksDir = join((await resolveConfigDir()).trim(), 'tasks');

  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { scanned: 0, removed: 0, retained: 0 };
    throw error;
  }

  const summary: MaaDynamicTaskCleanupSummary = { scanned: 0, removed: 0, retained: 0 };
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MAA_DYNAMIC_TASK_DIR_PREFIX)) continue;
    summary.scanned += 1;
    const taskDir = join(tasksDir, entry.name);
    const owner = await readDynamicTaskOwnerMarker(join(taskDir, MAA_DYNAMIC_TASK_OWNER_FILE));
    if (owner === null || now - owner.startedAt < expiryMs || isLiveProcess(owner.pid)) {
      summary.retained += 1;
      continue;
    }
    try {
      await rm(taskDir, { recursive: true, force: true });
      summary.removed += 1;
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        summary.removed += 1;
        continue;
      }
      summary.retained += 1;
      logger.warn('清理过期动态任务目录失败', { taskDir, error: errorMessageOf(error) });
    }
  }
  return summary;
}

export async function execDynamicTask(
  taskId: string,
  taskConfig: MaaDynamicTaskConfig | string,
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion = false,
  userResource = false,
  runtime: MaaDynamicTaskRuntime = {}
): Promise<MaaDynamicTaskOutput | MaaBackgroundStart> {
  const acquireExecutionLease = runtime.acquireExecutionLease || acquireMaaExecutionLease;
  const resolveConfigDir = runtime.getConfigDir || getMaaConfigDir;
  const makeDirectory = runtime.mkdir || mkdir;
  const writeTaskFile = runtime.writeFile || writeFile;
  const removeTaskDirectory = runtime.removeDirectory || rm;
  const executeCommand: MaaDynamicTaskExecutor = runtime.executeCommand || execMaaCommandUnlocked;
  const createNonce = runtime.createNonce || (() => `${process.pid}_${Date.now()}_${randomBytes(6).toString('hex')}`);
  const resolveClientType = runtime.resolveClientType
    || (async () => (await resolveConnection()).clientType);
  const lifecycle = runtime.lifecycle || {};
  const configObj = normalizeDynamicTaskParamAliases(normalizeDynamicTaskConfig(taskConfig));
  const validationMessage = validateGameTaskParams(configObj.type, configObj.params ?? {});
  if (validationMessage) {
    throw agentError('AGENT_VALIDATION_TASK_CONFIG_INVALID', validationMessage, { statusCode: 400 });
  }
  const gameTaskType: GameTaskType | null = configObj.type === 'OperProgress' || configObj.type === 'SwitchTheme'
    ? configObj.type
    : null;
  let logCheckpoint: MaaLogCheckpoint | null = null;
  const gameTaskAction = async (): Promise<GameTaskExecutionAction | null> => {
    if (!gameTaskType) return null;
    let logOutput = '';
    try {
      logOutput = await (runtime.readLogSince || readMaaLogSince)(logCheckpoint);
    } catch (error) {
      logger.warn('读取游戏任务结果失败', { error: errorMessageOf(error) });
    }
    return parseGameTaskExecutionAction(
      taskName || configObj.name,
      gameTaskType,
      logOutput,
      readOperProgressPlans(configObj.params ?? {})
    );
  };
  const gameTaskFailure = (action: GameTaskExecutionAction): MaaCommandError => agentError(
    'AGENT_GAME_TASK_FAILED',
    action.message,
    { statusCode: 422, details: { actions: [action] }, retryable: false }
  );

  const lease = await acquireExecutionLease({
    source: taskType || 'dynamic-task',
    taskName: taskName || String(taskId || 'dynamic-task'),
    command: 'run'
  });
  let tempTaskDir: string | null = null;
  let releaseOnReturn = true;

  const cleanup = async (): Promise<void> => {
    if (!tempTaskDir) return;
    await removeTaskDirectory(tempTaskDir, { recursive: true, force: true }).catch(error => {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    });
  };

  const cleanupAndRelease = async (): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      logger.warn('清理动态任务目录失败', { tempTaskDir, error: errorMessageOf(error) });
    } finally {
      await lease.release();
    }
  };

  try {
    const configDir = await resolveConfigDir();
    const taskClientTypeValue = configObj.params?.client_type;
    const taskClientType = typeof taskClientTypeValue === 'string' ? taskClientTypeValue.trim() : '';
    const explicitClientType = typeof runtime.clientType === 'string' ? runtime.clientType.trim() : '';
    let clientType = explicitClientType || taskClientType;
    if (!clientType) {
      const profileClientType = String(await resolveClientType()).trim();
      clientType = profileClientType || DEFAULT_CLIENT_TYPE;
    }
    const tasksDir = join(configDir.trim(), 'tasks');

    await makeDirectory(tasksDir, { recursive: true });

    const taskPrefix = String(taskId || 'dynamic-task')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 64) || 'dynamic-task';
    const taskDirName = `${MAA_DYNAMIC_TASK_DIR_PREFIX}${taskPrefix}-${createNonce()}`;
    tempTaskDir = join(tasksDir, taskDirName);

    await makeDirectory(tempTaskDir, { recursive: true });

    const taskFileId = 'task';
    const taskFile = join(tempTaskDir, `${taskFileId}.toml`);
    const ownerMarker = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

    const tomlContent = generateTaskToml(configObj, clientType);

    await writeTaskFile(join(tempTaskDir, MAA_DYNAMIC_TASK_OWNER_FILE), ownerMarker, 'utf-8');
    await writeTaskFile(taskFile, tomlContent, 'utf-8');
    addLog('INFO', `临时任务文件已创建: ${taskFile}`);
    addLog('DEBUG', `任务内容:\n${tomlContent}`);

    const runArgs = [join(taskDirName, taskFileId)];
    if (gameTaskType) {
      try {
        logCheckpoint = await (runtime.createLogCheckpoint || createMaaLogCheckpoint)();
      } catch (error) {
        logger.warn('创建游戏任务日志检查点失败', { error: errorMessageOf(error) });
      }
    }
    if (userResource) runArgs.push('--user-resource');
    runArgs.push('--batch');
    if (taskName && !waitForCompletion) {
      const { onSettled: lifecycleOnSettled, ...processLifecycle } = lifecycle;
      const result = await executeCommand(
        'run',
        runArgs,
        taskName,
        taskType,
        false,
        false,
        async (outcome: MaaCommandOutcome) => {
          let enrichedOutcome = outcome;
          try {
            if (!outcome.stopped) {
              const action = await gameTaskAction();
              if (action) {
                const result = { ...outcome.result, actions: [action] };
                if (outcome.error) {
                  outcome.error.details = { ...(isRecord(outcome.error.details) ? outcome.error.details : {}), actions: [action] };
                }
                enrichedOutcome = {
                  ...outcome,
                  result,
                  ...(outcome.ok && action.status === 'failed' ? { ok: false, error: gameTaskFailure(action) } : {})
                };
              }
            }
          } catch (error) {
            logger.warn('读取游戏任务结果失败', { error: errorMessageOf(error) });
          }
          try {
            await cleanupAndRelease();
          } catch (error) {
            logger.error('释放动态任务资源失败', { error: errorMessageOf(error) });
          }
          try {
            await lifecycleOnSettled?.(enrichedOutcome);
          } catch (error) {
            logger.error('处理动态任务终态失败', { error: errorMessageOf(error) });
          }
        },
        processLifecycle
      );
      releaseOnReturn = false;
      return result;
    }

    const result = await executeCommand('run', runArgs, taskName, taskType, waitForCompletion, false, null, lifecycle);
    const action = await gameTaskAction();
    if (action?.status === 'failed') throw gameTaskFailure(action);
    return action ? { ...result, actions: [action] } : result;
  } catch (error) {
    addLog('ERROR', `执行动态任务失败: ${errorMessageOf(error)}`);
    const fields = isRecord(error) ? error : {};
    if (fields.code === 'MAA_EXECUTION_BUSY' || fields.stopped) throw error;
    if (gameTaskType && fields.code !== 'AGENT_GAME_TASK_FAILED') {
      const action = await gameTaskAction();
      if (action) {
        const failure = commandErrorFields(error, `执行动态任务失败: ${errorMessageOf(error)}`);
        failure.details = { ...(isRecord(fields.details) ? fields.details : {}), actions: [action] };
        throw failure;
      }
    }
    throw commandErrorFields(error, `执行动态任务失败: ${errorMessageOf(error)}`);
  } finally {
    if (releaseOnReturn) await cleanupAndRelease();
  }
}

function formatTomlValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`TOML 数值必须是有限数字: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined && nestedValue !== null && nestedValue !== '')
      .map(([nestedKey, nestedValue]) => `${JSON.stringify(nestedKey)} = ${formatTomlValue(nestedValue)}`);
    return `{ ${entries.join(', ')} }`;
  }
  throw new TypeError(`不支持的 TOML 参数类型: ${typeof value}`);
}

function appendParamsToml(toml: string, table: string, params: Record<string, unknown>): string {
  if (Object.keys(params).length === 0) return toml;
  toml += `\n[${table}]\n`;

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;

    addLog('DEBUG', `处理参数 ${key}: ${typeof value} ${String(value)}`);

    if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
      try {
        const cleanValue = value.trim();
        const arrayValue: unknown = JSON.parse(cleanValue);
        if (Array.isArray(arrayValue)) {
          addLog('DEBUG', `  -> 解析为数组: ${JSON.stringify(arrayValue)}`);
          toml += `${key} = ${formatTomlValue(arrayValue)}\n`;
          continue;
        }
      } catch (e) {
        addLog('ERROR', `解析数组失败 ${key}: ${value} - ${errorMessageOf(e)}`);
      }
    }

    toml += `${key} = ${formatTomlValue(value)}\n`;
  }

  return toml;
}

function generateTaskToml(taskConfig: MaaDynamicTaskConfig, clientType: string): string {
  let toml = `client_type = ${formatTomlValue(clientType)}\n\n[[tasks]]\n`;
  toml += `name = ${formatTomlValue(taskConfig.name)}\n`;
  toml += `type = ${formatTomlValue(taskConfig.type)}\n`;
  if (taskConfig.strategy) {
    toml += `strategy = ${formatTomlValue(taskConfig.strategy)}\n`;
  }

  if (taskConfig.params && Object.keys(taskConfig.params).length > 0) {
    toml = appendParamsToml(toml, 'tasks.params', taskConfig.params);
  }

  for (const variant of taskConfig.variants ?? []) {
    toml += '\n[[tasks.variants]]\n';
    if (variant.condition && Object.keys(variant.condition).length > 0) {
      toml += `condition = ${formatTomlValue(variant.condition)}\n`;
    }
    if (variant.params && Object.keys(variant.params).length > 0) {
      toml = appendParamsToml(toml, 'tasks.variants.params', variant.params);
    }
  }

  addLog('DEBUG', `生成的 TOML:\n${toml}`);
  return toml;
}

function dynamicTaskStepActions(value: unknown): GameTaskExecutionAction[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.actions)) return undefined;
  const actions = value.actions.filter((action): action is GameTaskExecutionAction =>
    isRecord(action) && typeof action.task === 'string' && typeof action.status === 'string');
  return actions.length > 0 ? actions : undefined;
}

function dynamicTaskErrorActions(error: unknown): GameTaskExecutionAction[] | undefined {
  return isRecord(error) ? dynamicTaskStepActions(error.details) : undefined;
}

function dynamicTaskErrorText(error: unknown, field: 'stdout' | 'stderr'): string {
  return isRecord(error) && typeof error[field] === 'string' ? error[field] : '';
}

function isDynamicTaskStop(error: unknown): boolean {
  return isRecord(error) && error.stopped === true;
}

function isDynamicTaskPreStartStop(error: unknown): boolean {
  return isRecord(error) && error.code === 'AGENT_RUN_STOPPED_BEFORE_START';
}

function dynamicTaskResultMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === 'string' ? value.message : undefined;
}

function dynamicTaskStepOf(config: MaaDynamicTaskConfig, index: number): MaaDynamicTaskStep {
  return {
    ...config,
    index,
    status: 'pending',
    message: '未执行',
    stdout: '',
    stderr: ''
  };
}

function buildDynamicTasksOutput(
  steps: readonly MaaDynamicTaskStep[],
  stopped: boolean,
  message: string
): MaaDynamicTasksOutput {
  const actions = steps.flatMap(step => step.actions ?? []);
  return {
    stdout: steps.map(step => step.stdout).filter(Boolean).join('\n'),
    stderr: steps.map(step => step.stderr).filter(Boolean).join('\n'),
    command: 'run',
    stopped,
    tasks: [...steps],
    ...(actions.length > 0 ? { actions } : {}),
    message
  };
}

function boundDynamicTaskOutput(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS) return { value, truncated: false };
  return { value: value.slice(0, MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS), truncated: true };
}

function boundDynamicTaskStep(step: MaaDynamicTaskStep): MaaDynamicTaskErrorStep {
  const stdout = boundDynamicTaskOutput(step.stdout);
  const stderr = boundDynamicTaskOutput(step.stderr);
  return {
    ...step,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(stdout.truncated ? { stdoutTruncated: true } : {}),
    ...(stderr.truncated ? { stderrTruncated: true } : {})
  };
}

function dynamicTasksFailure(error: unknown, steps: readonly MaaDynamicTaskStep[]): MaaCommandError {
  const fields: Record<string, unknown> = isRecord(error) ? error : {};
  const failedIndexes = steps.filter(step => step.status === 'failed').map(step => step.index);
  const labels = failedIndexes.map(index => index + 1).join('、');
  const cause = errorMessageOf(error);
  const failure = commandErrorFields(
    error,
    `多任务执行失败：第 ${labels || '?'} 个任务未成功${cause ? `（${cause}）` : ''}`
  );
  failure.code = 'AGENT_DYNAMIC_TASKS_FAILED';
  failure.statusCode = typeof fields.statusCode === 'number' ? fields.statusCode : 500;
  failure.retryable = false;
  failure.details = {
    ...(isRecord(fields.details) ? fields.details : {}),
    taskIndexes: failedIndexes,
    tasks: steps.map(boundDynamicTaskStep),
    ...(typeof fields.code === 'string' || typeof fields.code === 'number' ? { causeCode: fields.code } : {})
  };
  return failure;
}

/**
 * 按任务数组顺序执行上游 task 模板，每项使用独立临时任务文件。
 * 失败不终止后续任务，最终由聚合错误携带逐项结果；停止只终止当前任务并
 * 把未开始项保持 pending，不再启动下一个任务。
 */
export async function execDynamicTasks(
  taskId: string,
  taskConfigs: readonly MaaDynamicTaskConfig[],
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion = false,
  userResource = false,
  runtime: MaaDynamicTaskRuntime = {}
): Promise<MaaDynamicTasksOutput | MaaDynamicTasksBackgroundStart> {
  if (taskConfigs.length === 0) {
    throw new TypeError('动态多任务至少需要一项');
  }

  const configs = taskConfigs.map(normalizeDynamicTaskConfig).map(normalizeDynamicTaskParamAliases);
  const acquireExecutionLease = runtime.acquireExecutionLease || acquireMaaExecutionLease;
  const lifecycle = runtime.lifecycle || {};
  const { onSettled: outerOnSettled, ...processLifecycle } = lifecycle;
  const baseTaskName = (taskName || configs[0].name || String(taskId || 'dynamic-task')).trim();
  const steps = configs.map((config, index) => dynamicTaskStepOf(config, index));
  const stepName = (index: number): string => `${baseTaskName} (${index + 1}/${configs.length})`;

  const lease = await acquireExecutionLease({
    source: taskType || 'dynamic-task',
    taskName: baseTaskName,
    command: 'run'
  });
  const noLeaseRuntime: MaaDynamicTaskRuntime = {
    ...runtime,
    acquireExecutionLease: async () => ({ release: async () => {} })
  };

  const releaseLease = async (): Promise<void> => {
    try {
      await lease.release();
    } catch (error) {
      logger.warn('释放动态多任务执行锁失败', { error: errorMessageOf(error) });
    }
  };

  const markPending = (startIndex: number, message = '任务已停止，未执行该任务'): void => {
    for (let index = startIndex; index < steps.length; index += 1) {
      if (steps[index].status !== 'pending') continue;
      steps[index].status = 'pending';
      steps[index].message = message;
    }
  };

  if (waitForCompletion) {
    let stopped = false;
    let firstError: unknown = null;
    try {
      for (let index = 0; index < configs.length; index += 1) {
        const step = steps[index];
        if (stopped) {
          step.status = 'pending';
          step.message = '任务已停止，未执行该任务';
          continue;
        }
        try {
          const result = await execDynamicTask(
            `${taskId}_${index + 1}`,
            configs[index],
            stepName(index),
            taskType,
            true,
            userResource,
            { ...noLeaseRuntime, lifecycle: processLifecycle }
          );
          step.stdout = result.stdout;
          step.stderr = result.stderr;
          const actions = dynamicTaskStepActions(result);
          if (actions) step.actions = actions;
          step.status = 'success';
          step.message = actions?.[0]?.message ?? dynamicTaskResultMessage(result) ?? '任务执行完成';
        } catch (error) {
          step.stdout = dynamicTaskErrorText(error, 'stdout');
          step.stderr = dynamicTaskErrorText(error, 'stderr');
          const actions = dynamicTaskErrorActions(error);
          if (actions) step.actions = actions;
          if (isDynamicTaskStop(error)) {
            stopped = true;
            step.status = isDynamicTaskPreStartStop(error) ? 'pending' : 'stopped';
            step.message = isDynamicTaskPreStartStop(error)
              ? '任务已停止，未执行该任务'
              : errorMessageOf(error);
            continue;
          }
          step.status = 'failed';
          step.message = errorMessageOf(error);
          firstError ??= error;
        }
      }

      if (stopped) {
        const completed = steps.filter(step => step.status === 'success').length;
        return buildDynamicTasksOutput(steps, true, `多任务执行已停止：已完成 ${completed}/${configs.length} 个任务`);
      }
      if (firstError) throw dynamicTasksFailure(firstError, steps);
      return buildDynamicTasksOutput(steps, false, `多任务执行完成：${configs.length} 个任务已完成`);
    } finally {
      await releaseLease();
    }
  }

  let stopped = false;
  let firstError: unknown = null;
  let stopError: unknown = null;
  let finalized = false;

  const finalizeTasksRun = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await releaseLease();
    const completed = steps.filter(step => step.status === 'success').length;
    const result = stopped
      ? buildDynamicTasksOutput(steps, true, `多任务执行已停止：已完成 ${completed}/${configs.length} 个任务`)
      : firstError
        ? buildDynamicTasksOutput(steps, false, `多任务执行结束：${completed}/${configs.length} 个任务成功`)
        : buildDynamicTasksOutput(steps, false, `多任务执行完成：${configs.length} 个任务已完成`);
    const outcomeResult: MaaCommandOutcome['result'] & MaaDynamicTasksOutput = {
      ...result,
      exitCode: null,
      signal: null
    };
    const outcome: MaaCommandOutcome = stopped
      ? { ok: false, stopped: true, result: outcomeResult, error: null }
      : firstError
        ? { ok: false, stopped: false, result: outcomeResult, error: dynamicTasksFailure(firstError, steps) }
        : { ok: true, stopped: false, result: outcomeResult, error: null };
    try {
      await outerOnSettled?.(outcome);
    } catch (error) {
      logger.error('处理动态多任务终态失败', { error: errorMessageOf(error) });
    }
  };

  const recordBackgroundOutcome = (index: number, outcome: MaaCommandOutcome): void => {
    const step = steps[index];
    step.stdout = outcome.result.stdout;
    step.stderr = outcome.result.stderr;
    const actions = dynamicTaskStepActions(outcome.result);
    if (actions) step.actions = actions;

    if (outcome.stopped) {
      stopped = true;
      step.status = 'stopped';
      step.message = outcome.error ? errorMessageOf(outcome.error) : '任务已停止';
      markPending(index + 1);
      void finalizeTasksRun();
      return;
    }

    if (outcome.ok) {
      step.status = 'success';
      step.message = actions?.[0]?.message ?? dynamicTaskResultMessage(outcome.result) ?? '任务执行完成';
    } else {
      step.status = 'failed';
      step.message = errorMessageOf(outcome.error);
      firstError ??= outcome.error;
      const errorActions = dynamicTaskErrorActions(outcome.error);
      if (errorActions) step.actions = errorActions;
    }

    void continueTaskChain(index + 1).catch(error => {
      if (finalized) return;
      firstError ??= error;
      void finalizeTasksRun();
    });
  };

  const startBackgroundTask = async (index: number): Promise<'started' | 'stopped' | 'failed'> => {
    const step = steps[index];
    try {
      await execDynamicTask(
        `${taskId}_${index + 1}`,
        configs[index],
        stepName(index),
        taskType,
        false,
        userResource,
        {
          ...noLeaseRuntime,
          lifecycle: {
            ...processLifecycle,
            onSettled: outcome => recordBackgroundOutcome(index, outcome)
          }
        }
      );
      if (step.status === 'pending') {
        step.status = 'running';
        step.message = '任务已开始，等待完成';
      }
      return 'started';
    } catch (error) {
      step.stdout = dynamicTaskErrorText(error, 'stdout');
      step.stderr = dynamicTaskErrorText(error, 'stderr');
      const actions = dynamicTaskErrorActions(error);
      if (actions) step.actions = actions;
      if (isDynamicTaskStop(error)) {
        stopError = error;
        step.status = 'pending';
        step.message = '任务已停止，未执行该任务';
        return 'stopped';
      }
      step.status = 'failed';
      step.message = errorMessageOf(error);
      firstError ??= error;
      return 'failed';
    }
  };

  async function continueTaskChain(index: number): Promise<void> {
    if (finalized) return;
    if (stopped) {
      markPending(index);
      await finalizeTasksRun();
      return;
    }
    if (index >= configs.length) {
      await finalizeTasksRun();
      return;
    }
    const status = await startBackgroundTask(index);
    if (status === 'started') return;
    if (status === 'stopped') {
      stopped = true;
      markPending(index + 1);
      await finalizeTasksRun();
      return;
    }
    await continueTaskChain(index + 1);
  }

  let nextIndex = 0;
  while (nextIndex < configs.length) {
    const status = await startBackgroundTask(nextIndex);
    if (status === 'started') break;
    if (status === 'stopped') {
      stopped = true;
      markPending(nextIndex + 1);
      await releaseLease();
      throw stopError ?? Object.assign(new Error('执行在开始前已被停止'), {
        code: 'AGENT_RUN_STOPPED_BEFORE_START',
        statusCode: 409,
        stopped: true,
        retryable: false
      });
    }
    nextIndex += 1;
  }

  if (nextIndex >= configs.length) {
    await releaseLease();
    throw dynamicTasksFailure(firstError, steps);
  }

  const acceptedSteps = steps.map(step => ({ ...step }));
  const acceptedActions = acceptedSteps.flatMap(step => step.actions ?? []);
  return {
    stdout: '',
    stderr: '',
    command: 'run',
    message: '多任务已在后台启动',
    stopped: false,
    tasks: acceptedSteps,
    ...(acceptedActions.length > 0 ? { actions: acceptedActions } : {})
  };
}
