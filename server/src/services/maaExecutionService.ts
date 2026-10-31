import { mkdir, writeFile, unlink } from 'node:fs/promises';
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

/**
 * 需要设备变更权的命令与执行入口。
 *
 * - 设备租约来自 executionCoordinatorService，与 maaProcessService 的子进程
 *   状态、agentRunService 的 Run 终态是三个独立对象；这里只决定“是否必须先
 *   取得租约、何时释放”，不另外保存执行状态。
 * - 后台执行的租约在子进程实际退出（onSettled）后释放；返回“已启动”响应
 *   不等于执行完成。
 * - 动态任务在配置目录写临时 TOML，失败与完成都清理文件并释放租约；任务
 *   文件、租约与生命周期回调都可经 runtime 端口注入测试。
 */

const logger = createLogger('MaaService');

const DEVICE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'startup', 'closedown', 'fight', 'run', 'copilot', 'ssscopilot', 'paradoxcopilot',
  'roguelike', 'reclamation', 'infrast', 'recruit', 'mall', 'award', 'depot', 'operbox',
  'install', 'update', 'hot-update'
]);

/** MAA 版本查询结果；raw 保留 CLI 原始输出。 */
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

/** 动态任务文件内容：name/type 决定任务类型，params 写入 TOML 表。 */
export interface MaaDynamicTaskConfig {
  name: string;
  type: string;
  params?: Record<string, unknown>;
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

/** 动态任务的注入端口：租约、配置目录、文件 IO、执行器与随机标识。 */
export interface MaaDynamicTaskRuntime {
  acquireExecutionLease?: MaaExecutionLeaseAcquirer;
  getConfigDir?: () => Promise<string>;
  mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, content: string, encoding: 'utf-8') => Promise<unknown>;
  unlink?: (path: string) => Promise<unknown>;
  executeCommand?: MaaDynamicTaskExecutor;
  createNonce?: () => string;
  lifecycle?: MaaProcessLifecycle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 错误对象的可复制字段；后台失败保留 code/statusCode/退出信息。 */
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

/**
 * 获取 MAA 版本信息
 */
export async function getMaaVersion(silent = false): Promise<MaaVersionInfo> {
  const result = await execMaaCommand('version', [], null, null, false, silent);
  const output = result.stdout;

  // 解析版本信息
  // 输出格式: "maa-cli v0.7.0\nMaaCore v6.2.3\n"
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

/** 动态任务配置来自 HTTP 或内部构造：字符串按 JSON 解析，字段逐项收窄。 */
function normalizeDynamicTaskConfig(taskConfig: MaaDynamicTaskConfig | string): MaaDynamicTaskConfig {
  const parsed: unknown = typeof taskConfig === 'string' ? JSON.parse(taskConfig) : taskConfig;
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.type !== 'string') {
    throw new TypeError('动态任务配置必须包含 name 与 type');
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  return { name: parsed.name, type: parsed.type, params };
}

/**
 * 创建临时任务文件并执行
 */
export async function execDynamicTask(
  taskId: string,
  taskConfig: MaaDynamicTaskConfig | string,
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion = false,
  userResource = false,
  runtime: MaaDynamicTaskRuntime = {}
): Promise<MaaCommandOutput | MaaBackgroundStart> {
  const acquireExecutionLease = runtime.acquireExecutionLease || acquireMaaExecutionLease;
  const resolveConfigDir = runtime.getConfigDir || getMaaConfigDir;
  const makeDirectory = runtime.mkdir || mkdir;
  const writeTaskFile = runtime.writeFile || writeFile;
  const removeTaskFile = runtime.unlink || unlink;
  const executeCommand: MaaDynamicTaskExecutor = runtime.executeCommand || execMaaCommandUnlocked;
  const createNonce = runtime.createNonce || (() => `${process.pid}_${Date.now()}_${randomBytes(6).toString('hex')}`);
  const lifecycle = runtime.lifecycle || {};

  const lease = await acquireExecutionLease({
    source: taskType || 'dynamic-task',
    taskName: taskName || String(taskId || 'dynamic-task'),
    command: 'run'
  });
  let tempTaskFile: string | null = null;
  let releaseOnReturn = true;

  const cleanup = async (): Promise<void> => {
    if (!tempTaskFile) return;
    await removeTaskFile(tempTaskFile).catch(error => {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    });
  };

  const cleanupAndRelease = async (): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      logger.warn('清理动态任务文件失败', { tempTaskFile, error: errorMessageOf(error) });
    } finally {
      await lease.release();
    }
  };

  try {
    const configDir = await resolveConfigDir();
    const tasksDir = join(configDir.trim(), 'tasks');

    // 确保 tasks 目录存在
    await makeDirectory(tasksDir, { recursive: true });

    const taskPrefix = String(taskId || 'dynamic-task')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 64) || 'dynamic-task';
    const taskFileId = `${taskPrefix}_temp_${createNonce()}`;
    tempTaskFile = join(tasksDir, `${taskFileId}.toml`);

    // 将 taskConfig 转换为对象（如果是字符串则解析，如果已经是对象则直接使用）
    const configObj = normalizeDynamicTaskConfig(taskConfig);

    // 将配置对象转换为 TOML 格式
    const tomlContent = generateTaskToml(configObj);

    // 写入临时文件
    await writeTaskFile(tempTaskFile, tomlContent, 'utf-8');
    addLog('INFO', `临时任务文件已创建: ${tempTaskFile}`);
    addLog('DEBUG', `任务内容:\n${tomlContent}`);

    // 执行任务
    const runArgs = [taskFileId];
    if (userResource) runArgs.push('--user-resource');
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
          try {
            await cleanupAndRelease();
          } catch (error) {
            logger.error('释放动态任务资源失败', { error: errorMessageOf(error) });
          }
          try {
            await lifecycleOnSettled?.(outcome);
          } catch (error) {
            logger.error('处理动态任务终态失败', { error: errorMessageOf(error) });
          }
        },
        processLifecycle
      );
      releaseOnReturn = false;
      return result;
    }

    return await executeCommand('run', runArgs, taskName, taskType, waitForCompletion, false, null, lifecycle);
  } catch (error) {
    addLog('ERROR', `执行动态任务失败: ${errorMessageOf(error)}`);
    const fields = isRecord(error) ? error : {};
    if (fields.code === 'MAA_EXECUTION_BUSY' || fields.stopped) throw error;
    throw commandErrorFields(error, `执行动态任务失败: ${errorMessageOf(error)}`);
  } finally {
    if (releaseOnReturn) await cleanupAndRelease();
  }
}

/**
 * 生成任务 TOML 内容
 */
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

function generateTaskToml(taskConfig: MaaDynamicTaskConfig): string {
  let toml = '[[tasks]]\n';
  toml += `name = ${formatTomlValue(taskConfig.name)}\n`;
  toml += `type = ${formatTomlValue(taskConfig.type)}\n`;

  if (taskConfig.params && Object.keys(taskConfig.params).length > 0) {
    toml += '\n[tasks.params]\n';

    for (const [key, value] of Object.entries(taskConfig.params)) {
      if (value === undefined || value === null || value === '') continue;

      addLog('DEBUG', `处理参数 ${key}: ${typeof value} ${String(value)}`);

      // 处理字符串形式的数组，如 "[4,5,6]"
      if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
        try {
          // 移除空格并解析
          const cleanValue = value.trim();
          const arrayValue: unknown = JSON.parse(cleanValue);
          if (Array.isArray(arrayValue)) {
            addLog('DEBUG', `  -> 解析为数组: ${JSON.stringify(arrayValue)}`);
            toml += `${key} = ${formatTomlValue(arrayValue)}\n`;
            continue;
          }
        } catch (e) {
          addLog('ERROR', `解析数组失败 ${key}: ${value} - ${errorMessageOf(e)}`);
          // 如果解析失败，继续按普通字符串处理
        }
      }

      toml += `${key} = ${formatTomlValue(value)}\n`;
    }
  }

  addLog('DEBUG', `生成的 TOML:\n${toml}`);
  return toml;
}
