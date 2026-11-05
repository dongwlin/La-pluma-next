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
import { validateGameTaskParams } from './gameTaskConfigService.ts';
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

export interface MaaDynamicTaskConfig {
  name: string;
  type: string;
  params?: Record<string, unknown>;
}

export const MAA_DYNAMIC_TASK_DIR_PREFIX = 'la-pluma-task-';
export const MAA_DYNAMIC_TASK_OWNER_FILE = 'owner.json';
export const MAA_DYNAMIC_TASK_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
  lifecycle?: MaaProcessLifecycle;
  createLogCheckpoint?: () => Promise<MaaLogCheckpoint | null>;
  readLogSince?: (checkpoint: MaaLogCheckpoint | null) => Promise<string>;
}

export interface MaaDynamicTaskOutput extends MaaCommandOutput {
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

function normalizeDynamicTaskConfig(taskConfig: MaaDynamicTaskConfig | string): MaaDynamicTaskConfig {
  const parsed: unknown = typeof taskConfig === 'string' ? JSON.parse(taskConfig) : taskConfig;
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.type !== 'string') {
    throw new TypeError('动态任务配置必须包含 name 与 type');
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  return { name: parsed.name, type: parsed.type, params };
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
  const configObj = normalizeDynamicTaskConfig(taskConfig);
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
    const clientType = (await resolveClientType()).trim() || DEFAULT_CLIENT_TYPE;
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

function generateTaskToml(taskConfig: MaaDynamicTaskConfig, clientType: string): string {
  let toml = `client_type = ${formatTomlValue(clientType)}\n\n[[tasks]]\n`;
  toml += `name = ${formatTomlValue(taskConfig.name)}\n`;
  toml += `type = ${formatTomlValue(taskConfig.type)}\n`;

  if (taskConfig.params && Object.keys(taskConfig.params).length > 0) {
    toml += '\n[tasks.params]\n';

    for (const [key, value] of Object.entries(taskConfig.params)) {
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
  }

  addLog('DEBUG', `生成的 TOML:\n${toml}`);
  return toml;
}
