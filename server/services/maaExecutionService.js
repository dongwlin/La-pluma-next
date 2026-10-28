import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../utils/logger.ts';
import { acquireMaaExecutionLease } from './executionCoordinatorService.ts';
import { addLog, execMaaCommandUnlocked } from './maaProcessService.js';
import { getMaaConfigDir } from './maaConfigService.js';

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

const DEVICE_MUTATING_COMMANDS = new Set([
  'startup', 'closedown', 'fight', 'run', 'copilot', 'ssscopilot', 'paradoxcopilot',
  'roguelike', 'reclamation', 'infrast', 'recruit', 'mall', 'award', 'depot', 'operbox',
  'install', 'update', 'hot-update'
]);

export function requiresMaaExecutionLease(command) {
  return DEVICE_MUTATING_COMMANDS.has(command);
}

export async function execMaaCommand(command, args = [], taskName = null, taskType = null, waitForCompletion = false, silent = false, lifecycle = {}, ports = {}) {
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
            logger.error('释放 MAA 执行锁失败', { error: error.message });
          }
          try {
            await lifecycleOnSettled?.(outcome);
          } catch (error) {
            logger.error('处理 MAA 后台任务终态失败', { error: error.message });
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
export async function getMaaVersion(silent = false) {
  const result = await execMaaCommand('version', [], null, null, false, silent);
  const output = result.stdout;

  // 解析版本信息
  // 输出格式: "maa-cli v0.7.0\nMaaCore v6.2.3\n"
  const lines = output.trim().split('\n');
  const versions = {
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

/**
 * 创建临时任务文件并执行
 */
export async function execDynamicTask(taskId, taskConfig, taskName = null, taskType = null, waitForCompletion = false, userResource = false, runtime = {}) {
  const acquireExecutionLease = runtime.acquireExecutionLease || acquireMaaExecutionLease;
  const resolveConfigDir = runtime.getConfigDir || getMaaConfigDir;
  const makeDirectory = runtime.mkdir || mkdir;
  const writeTaskFile = runtime.writeFile || writeFile;
  const removeTaskFile = runtime.unlink || unlink;
  const executeCommand = runtime.executeCommand || execMaaCommandUnlocked;
  const createNonce = runtime.createNonce || (() => `${process.pid}_${Date.now()}_${randomBytes(6).toString('hex')}`);
  const lifecycle = runtime.lifecycle || {};

  const lease = await acquireExecutionLease({
    source: taskType || 'dynamic-task',
    taskName: taskName || String(taskId || 'dynamic-task'),
    command: 'run'
  });
  let tempTaskFile = null;
  let releaseOnReturn = true;

  const cleanup = async () => {
    if (!tempTaskFile) return;
    await removeTaskFile(tempTaskFile).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
  };

  const cleanupAndRelease = async () => {
    try {
      await cleanup();
    } catch (error) {
      logger.warn('清理动态任务文件失败', { tempTaskFile, error: error.message });
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
    const configObj = typeof taskConfig === 'string' ? JSON.parse(taskConfig) : taskConfig;

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
        async (outcome) => {
          try {
            await cleanupAndRelease();
          } catch (error) {
            logger.error('释放动态任务资源失败', { error: error.message });
          }
          try {
            await lifecycleOnSettled?.(outcome);
          } catch (error) {
            logger.error('处理动态任务终态失败', { error: error.message });
          }
        },
        processLifecycle
      );
      releaseOnReturn = false;
      return result;
    }

    return await executeCommand('run', runArgs, taskName, taskType, waitForCompletion, false, null, lifecycle);
  } catch (error) {
    addLog('ERROR', `执行动态任务失败: ${error.message}`);
    if (error?.code === 'MAA_EXECUTION_BUSY' || error?.stopped) throw error;
    const dynamicTaskError = new Error(`执行动态任务失败: ${error.message}`, { cause: error });
    dynamicTaskError.code = error?.code;
    dynamicTaskError.statusCode = error?.statusCode;
    dynamicTaskError.details = error?.details;
    dynamicTaskError.retryable = error?.retryable;
    dynamicTaskError.exitCode = error?.exitCode;
    dynamicTaskError.signal = error?.signal;
    throw dynamicTaskError;
  } finally {
    if (releaseOnReturn) await cleanupAndRelease();
  }
}

/**
 * 生成任务 TOML 内容
 */
function formatTomlValue(value) {
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

function generateTaskToml(taskConfig) {
  let toml = '[[tasks]]\n';
  toml += `name = ${formatTomlValue(taskConfig.name)}\n`;
  toml += `type = ${formatTomlValue(taskConfig.type)}\n`;

  if (taskConfig.params && Object.keys(taskConfig.params).length > 0) {
    toml += '\n[tasks.params]\n';

    for (const [key, value] of Object.entries(taskConfig.params)) {
      if (value === undefined || value === null || value === '') continue;

      addLog('DEBUG', `处理参数 ${key}: ${typeof value} ${value}`);

      // 处理字符串形式的数组，如 "[4,5,6]"
      if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
        try {
          // 移除空格并解析
          const cleanValue = value.trim();
          const arrayValue = JSON.parse(cleanValue);
          if (Array.isArray(arrayValue)) {
            addLog('DEBUG', `  -> 解析为数组: ${JSON.stringify(arrayValue)}`);
            toml += `${key} = ${formatTomlValue(arrayValue)}\n`;
            continue;
          }
        } catch (e) {
          addLog('ERROR', `解析数组失败 ${key}: ${value} - ${e.message}`);
          // 如果解析失败，继续按普通字符串处理
        }
      }

      toml += `${key} = ${formatTomlValue(value)}\n`;
    }
  }

  addLog('DEBUG', `生成的 TOML:\n${toml}`);
  return toml;
}
