/**
 * Core / CLI / 资源更新的执行编排
 *
 * 三类更新共用同一组执行边界：取得设备变更租约、在产生子进程前经过 Run 的
 * pre-start 门禁、执行维护命令、刷新版本投影，并把失败归一化成稳定的更新错误。
 * 本模块只负责执行与领域结果，不写 HTTP envelope；Run 身份、幂等与终态由
 * agentRunService 持有，调用方组合两者。
 *
 * 受管子进程名与 maaProcessService 的 taskStatus 投影保持一致：停止请求和关闭
 * 流程按同一任务进程路径识别并终止更新，不依赖额外注册表。
 */

import { agentError } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import type { MaaVersionInfo } from './maaExecutionService.ts';
import { execMaaCommand, getMaaVersion } from './maaExecutionService.ts';
import { MAINTENANCE_EXEC_TIMEOUT_MS } from './maaProcessService.ts';
import type { MaaCommandOutput, MaaProcessLifecycle, MaaProcessPorts } from './maaProcessService.ts';
import { runCliUpdater } from './cliUpdaterService.ts';
import type { CliUpdaterPlan } from './cliUpdaterService.ts';
import {
  getMaaResourceInfo,
  RESOURCE_UPDATE_IN_PROGRESS_CODE,
  updateMaaResources
} from './resourceUpdateService.ts';
import type { ResourceInfo } from './resourceUpdateService.ts';
import { saveUpdateChannel } from './updateChannelService.ts';
import type { CliUpdateChannel, CoreUpdateChannel } from './updateChannelService.ts';

const logger = createLogger('UpdateService');

/** 受管任务名：同时写入 taskStatus 与租约元数据，停止/关闭按它识别更新进程。 */
export const CORE_UPDATE_TASK_NAME = '更新 MaaCore 与资源';
export const CLI_UPDATE_TASK_NAME = '更新 MAA CLI';
export const RESOURCE_UPDATE_TASK_NAME = '同步 MAA 资源';

/** Run operationId：与执行入口一一对应，不按页面或调用方区分。 */
export const UPDATE_OPERATION_IDS = {
  core: 'update_core',
  cli: 'update_cli',
  resources: 'update_resources'
} as const;

export type UpdateOperationId = (typeof UPDATE_OPERATION_IDS)[keyof typeof UPDATE_OPERATION_IDS];

export interface CoreUpdateRunOptions {
  requestedChannel: CoreUpdateChannel | null;
  version: unknown;
  lifecycle?: MaaProcessLifecycle;
}

export interface CoreUpdateRunResult {
  output: string;
  runtime: MaaVersionInfo;
  resource: ResourceInfo;
  channelPersisted: boolean;
}

export interface CliUpdateRunOptions {
  updater: CliUpdaterPlan;
  channel: CliUpdateChannel;
  explicitChannel: CliUpdateChannel | null;
  lifecycle?: MaaProcessLifecycle;
}

export interface CliUpdateRunResult {
  output: string;
  channel: CliUpdateChannel;
}

export interface ResourceUpdateRunOptions {
  lifecycle?: MaaProcessLifecycle;
}

export interface ResourceUpdateRunResult {
  output: string;
  resource: ResourceInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function errorCodeOf(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

/**
 * 停止、关闭、占用与并发冲突不是更新失败：保持原错误交给 Run 状态机与统一错误出口，
 * 不能被归一化成可重试的更新失败或写成成功。
 */
function isExecutionControlError(error: unknown): boolean {
  if (isRecord(error) && error.stopped === true) return true;
  const code = errorCodeOf(error);
  return code === 'MAA_EXECUTION_BUSY'
    || code === 'MAA_EXECUTION_SHUTTING_DOWN'
    || code === 'AGENT_EXECUTION_SHUTTING_DOWN'
    || code === 'AGENT_RUN_STOPPED_BEFORE_START'
    || code === RESOURCE_UPDATE_IN_PROGRESS_CODE;
}

function coreUpdateFailure(error: unknown, version: unknown): unknown {
  if (isExecutionControlError(error)) return error;
  return agentError('AGENT_MAA_UPDATE_CORE_FAILED', `MaaCore 更新失败: ${errorMessageOf(error)}`, {
    statusCode: 500,
    retryable: true,
    details: { version, failedStep: 'core', coreUpdated: false }
  });
}

/**
 * Core 命令已成功、资源状态却无法确认：保持旧版 `failedStep: 'resources'` +
 * `coreUpdated: true` 归因，客户端据此重新提供资源重试入口。
 */
function coreResourceFailure(error: unknown, version: unknown, runtime: MaaVersionInfo): unknown {
  return agentError('AGENT_MAA_UPDATE_RESOURCE_FAILED', `MaaCore 已更新，但资源同步未能确认: ${errorMessageOf(error)}`, {
    statusCode: 500,
    retryable: true,
    details: { version, failedStep: 'resources', coreUpdated: true, runtime }
  });
}

/**
 * Core 命令已成功、版本投影却读不到：归因到 runtime 步骤，不能标记成 core 未更新。
 */
function coreRuntimeFailure(error: unknown, version: unknown): unknown {
  if (isExecutionControlError(error)) return error;
  return agentError('AGENT_MAA_UPDATE_CORE_FAILED', `MaaCore 已更新，但版本读取失败: ${errorMessageOf(error)}`, {
    statusCode: 500,
    retryable: true,
    details: { version, failedStep: 'runtime', coreUpdated: true }
  });
}

/** 已按失败步骤归一化的更新错误：外层兜底不能再改写成 core 步骤失败。 */
function isUpdateFailureError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'AGENT_MAA_UPDATE_CORE_FAILED' || code === 'AGENT_MAA_UPDATE_RESOURCE_FAILED';
}

function cliUpdateFailure(error: unknown, channel: CliUpdateChannel, source: string): unknown {
  if (isExecutionControlError(error)) return error;
  return agentError('AGENT_MAA_UPDATE_CLI_FAILED', `MAA CLI 更新失败: ${errorMessageOf(error)}`, {
    statusCode: 500,
    retryable: true,
    details: { channel, source }
  });
}

function resourceUpdateFailure(error: unknown): unknown {
  if (isExecutionControlError(error)) return error;
  return agentError('AGENT_MAA_RESOURCE_UPDATE_FAILED', `资源同步失败: ${errorMessageOf(error)}`, {
    statusCode: 500,
    retryable: true,
    details: { failedStep: 'resources' }
  });
}

/**
 * 安装/更新 MaaCore 并刷新版本投影。渠道切换成功后持久化渠道；持久化失败不把
 * 已完成的更新标记为失败，但经 `channelPersisted` 让调用方看见渠道未落盘。
 */
export async function runCoreUpdate({
  requestedChannel,
  version,
  lifecycle
}: CoreUpdateRunOptions): Promise<CoreUpdateRunResult> {
  try {
    return await withMaaExecutionLease({
      source: 'core-update',
      taskName: CORE_UPDATE_TASK_NAME,
      command: 'update'
    }, async () => {
      // Core 安装/更新是大包下载：走维护专用长超时，并在子进程产生前经过
      // lifecycle.onBeforeStart 的 Run 门禁。
      const ports: MaaProcessPorts = {
        execFileTimeoutMs: MAINTENANCE_EXEC_TIMEOUT_MS,
        managedTaskName: CORE_UPDATE_TASK_NAME
      };
      const coreResult: MaaCommandOutput = requestedChannel
        ? await execMaaCommand('install', [requestedChannel, '--force'], null, null, true, false, lifecycle, ports)
        : await execMaaCommand('update', [], null, null, true, false, lifecycle, ports);
      let channelPersisted = true;
      if (requestedChannel) {
        // 切换渠道后持久化到 cli.toml，后续不带 version 的更新继续使用该渠道。
        try {
          await saveUpdateChannel('core', requestedChannel);
        } catch (error) {
          channelPersisted = false;
          logger.error('MaaCore 渠道持久化失败', { error: errorMessageOf(error), version });
        }
      }
      // maa-cli 的 install/update 自带资源同步；这里只刷新投影，不能再跑一次资源更新。
      // 只有 core 命令成功后才读取投影：读到的对象就是成功载荷里的实测状态。
      let runtime: MaaVersionInfo;
      try {
        runtime = await getMaaVersion(true);
      } catch (error) {
        throw coreRuntimeFailure(error, version);
      }
      let resource: ResourceInfo;
      try {
        resource = await getMaaResourceInfo();
      } catch (error) {
        throw coreResourceFailure(error, version, runtime);
      }
      if (resource.status === 'unknown') {
        throw coreResourceFailure(new Error(resource.message), version, runtime);
      }
      return {
        output: coreResult.stdout || coreResult.stderr || '',
        runtime,
        resource,
        channelPersisted
      };
    });
  } catch (error) {
    if (isUpdateFailureError(error)) throw error;
    throw coreUpdateFailure(error, version);
  }
}

/**
 * 执行 MAA CLI 更新；子进程登记为受管任务，可通过 Run 停止与关闭流程终止。
 */
export async function runCliUpdate({
  updater,
  channel,
  explicitChannel,
  lifecycle
}: CliUpdateRunOptions): Promise<CliUpdateRunResult> {
  try {
    return await withMaaExecutionLease({
      source: 'cli-update',
      taskName: CLI_UPDATE_TASK_NAME,
      command: 'update-cli'
    }, async () => {
      const { stdout, stderr } = await runCliUpdater(updater, { lifecycle });
      if (explicitChannel) {
        // 显式切换后持久化，后续无参更新从 cli.toml 读取同一渠道。
        await saveUpdateChannel('cli', explicitChannel).catch(error => {
          logger.error('MAA CLI 渠道持久化失败', { error: errorMessageOf(error), channel });
        });
      }
      return { output: stdout || stderr, channel };
    });
  } catch (error) {
    throw cliUpdateFailure(error, channel, updater.source);
  }
}

/** 同步 MAA 资源并刷新资源信息；`hot-update` 由资源服务持租约执行。 */
export async function runResourceUpdate({
  lifecycle
}: ResourceUpdateRunOptions = {}): Promise<ResourceUpdateRunResult> {
  try {
    const result = await updateMaaResources({ lifecycle });
    return { output: result.output, resource: result.resource };
  } catch (error) {
    throw resourceUpdateFailure(error);
  }
}
