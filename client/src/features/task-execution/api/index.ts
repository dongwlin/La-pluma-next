/**
 * 任务执行微域 API
 * MAA 命令执行、预定义任务提交以及任务运行状态查询与终止。
 * 这些端点被日常、战斗、肉鸽、统计与运行时状态多个域共用，因此独立成微域。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

/**
 * 任务配置接口
 */
export interface TaskConfig {
  [key: string]: any
}

/**
 * 提交执行时可选的请求语义。幂等键由服务端按 operationId 分区；
 * 不传时保持旧行为（每次请求都是新的 run）。
 */
export interface AgentRequestOptions {
  idempotencyKey?: string
}

/**
 * 执行 MAA 命令
 */
export async function executeCommand(
  command: string,
  args: string[] = [],
  taskConfig: TaskConfig | null = null,
  signal: AbortSignal | null = null,
  taskName: string | null = null,
  taskType: string | null = null,
  waitForCompletion: boolean = false,
  options: AgentRequestOptions = {}
): Promise<ApiResponse> {
  const body: Record<string, any> = { command, args }

  if (taskConfig) {
    body.taskConfig = taskConfig
  }
  if (taskName) {
    body.taskName = taskName
  }
  if (taskType) {
    body.taskType = taskType
  }
  if (waitForCompletion !== undefined) {
    body.waitForCompletion = waitForCompletion
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey
  }

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }

  // 如果提供了 abort signal，添加到 fetch 选项中
  if (signal) {
    fetchOptions.signal = signal
  }

  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/run-task`, fetchOptions)
  return parseJsonResponse(response)
}

/**
 * 使用结构化参数执行预定义任务，避免字符串 split 破坏本地路径/URL
 */
export async function executePredefinedTaskArgs(
  taskType: string,
  args: string[] = [],
  taskConfig: TaskConfig | null = null,
  signal: AbortSignal | null = null,
  taskName: string | null = null,
  taskTypeLabel: string | null = null,
  waitForCompletion: boolean = false,
  options: AgentRequestOptions = {}
): Promise<ApiResponse> {
  return executeCommand(taskType, args, taskConfig, signal, taskName, taskTypeLabel, waitForCompletion, options)
}

/**
 * 执行预定义任务
 */
export async function executePredefinedTask(
  taskType: string,
  params: string,
  taskConfig: TaskConfig | null = null,
  signal: AbortSignal | null = null,
  taskName: string | null = null,
  taskTypeLabel: string | null = null,
  waitForCompletion: boolean = false,
  options: AgentRequestOptions = {}
): Promise<ApiResponse> {
  // 按 shell 风格切分参数，保留带引号的本地路径与远程 URL
  const args = params
    ? (params.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map(arg => arg.replace(/^("|')|("|')$/g, ''))
        .filter(arg => arg.trim())
    : []
  return executeCommand(taskType, args, taskConfig, signal, taskName, taskTypeLabel, waitForCompletion, options)
}

/**
 * 获取任务执行状态（旧客户端的进程投影）
 */
export async function getTaskStatus(signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/tasks/status`, { signal })
  return parseJsonResponse(response)
}

/**
 * 终止当前任务（旧入口，不带 runId）。
 * 需要保护特定执行时使用 runs 模块的 stopRun。
 */
export async function stopTask(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/stop`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

export {
  getRun,
  getRunSnapshot,
  stopRun,
} from './runs'
