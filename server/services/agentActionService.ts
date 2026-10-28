import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';

/**
 * Agent 动作用例与请求归一化
 *
 * 类型边界：HTTP 请求体、动态任务配置与执行器依赖都是 unknown 入口，
 * 由本模块按既有规则逐项收窄；命令白名单、动态任务 ID 规则、标签长度
 * 与 `waitForCompletion` 的布尔要求保持迁移前的错误码、文案与接受时机。
 * 执行器由调用方注入，本模块不直接启动子进程或持有 Run。
 */

export const AGENT_TASK_COMMANDS = Object.freeze([
  'startup',
  'closedown',
  'fight',
  'infrast',
  'recruit',
  'mall',
  'award',
  'copilot',
  'ssscopilot',
  'paradoxcopilot',
  'roguelike',
  'depot',
  'operbox',
  'activity',
  'run',
  'list'
] as const);

export type AgentTaskCommand = (typeof AGENT_TASK_COMMANDS)[number];

const AGENT_TASK_COMMAND_SET: ReadonlySet<string> = new Set(AGENT_TASK_COMMANDS);
const AGENT_QUERY_COMMANDS: ReadonlySet<string> = new Set(['activity', 'list']);
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 动态任务配置：`name`/`type` 必填，其余字段原样透传给 MAA。 */
export interface AgentTaskConfig extends Record<string, unknown> {
  name: string;
  type: string;
  params: Record<string, unknown>;
}

/** 命令执行器端口：只转发已归一化的参数，设备与租约仍由实现持有。 */
export type AgentTaskCommandExecutor = (
  command: string,
  args: readonly string[],
  taskName: string | null,
  taskType: string | null,
  waitForCompletion: boolean
) => Promise<unknown>;

export type AgentTaskDynamicExecutor = (
  taskId: string,
  taskConfig: AgentTaskConfig,
  taskName: string,
  taskType: string,
  waitForCompletion: boolean,
  userResource: boolean
) => Promise<unknown>;

export interface AgentTaskDependencies {
  execMaaCommand?: AgentTaskCommandExecutor;
  execDynamicTask?: AgentTaskDynamicExecutor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 旧实现的模板字符串/属性访问按文本输出未知值，保留同一归一。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function errorMessageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function receivedTypeOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

function invalidRequest(code: string, message: string, details: Record<string, unknown>): AgentError {
  return agentError(code, message, {
    statusCode: 400,
    details,
    retryable: false
  });
}

function normalizeTaskConfig(taskConfig: unknown): AgentTaskConfig {
  let normalized: unknown = taskConfig;

  if (typeof taskConfig === 'string') {
    try {
      normalized = JSON.parse(taskConfig);
    } catch (error) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        'taskConfig 必须是有效的 JSON 对象',
        { reason: 'invalid_json', parseError: errorMessageOf(error) }
      );
    }
  }

  if (!isRecord(normalized)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig 必须是非数组对象',
      {
        reason: 'object_required',
        receivedType: Array.isArray(normalized) ? 'array' : normalized === null ? 'null' : typeof normalized
      }
    );
  }

  if (typeof normalized.name !== 'string' || !normalized.name.trim()
    || typeof normalized.type !== 'string' || !normalized.type.trim()) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig.name 和 taskConfig.type 必须是非空字符串',
      { reason: 'name_and_type_required' }
    );
  }

  const params = normalized.params;
  if (params !== undefined && !isRecord(params)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig.params 必须是对象',
      { reason: 'params_object_required' }
    );
  }

  return {
    ...normalized,
    name: normalized.name.trim(),
    type: normalized.type.trim(),
    params: params ?? {}
  };
}

function normalizeOptionalLabel(value: unknown, field: string, fallback: string, maxLength: number): string {
  const errorField = field.replace(/[A-Z]/g, character => `_${character}`).toUpperCase();
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw invalidRequest(
      `AGENT_VALIDATION_${errorField}_INVALID`,
      `${field} 必须是字符串`,
      { receivedType: receivedTypeOf(value) }
    );
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidRequest(
      `AGENT_VALIDATION_${errorField}_INVALID`,
      `${field} 长度不能超过 ${maxLength} 个字符`,
      { maxLength, actualLength: normalized.length }
    );
  }
  return normalized || fallback;
}

/** 日常流程请求：`taskFlow` 保持 unknown[]，步骤校验仍由 scheduler 域判定。 */
export interface NormalizedDailyFlowRequest {
  dryRun: boolean;
  scheduleId: string;
  taskFlow: unknown[] | null;
  waitForCompletion: boolean;
}

export function normalizeDailyFlowRequest(input: unknown = {}): NormalizedDailyFlowRequest {
  if (!isRecord(input)) {
    throw invalidRequest('AGENT_VALIDATION_DAILY_FLOW_INPUT_INVALID', '请求体必须是对象', {
      receivedType: receivedTypeOf(input)
    });
  }

  const dryRun = input.dryRun ?? false;
  if (typeof dryRun !== 'boolean') {
    throw invalidRequest('AGENT_VALIDATION_DRY_RUN_INVALID', 'dryRun 必须是布尔值', {
      receivedType: typeof dryRun
    });
  }

  const waitForCompletion = input.waitForCompletion ?? true;
  if (typeof waitForCompletion !== 'boolean') {
    throw invalidRequest('AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID', 'waitForCompletion 必须是布尔值', {
      receivedType: typeof waitForCompletion
    });
  }

  const scheduleId = normalizeOptionalLabel(input.scheduleId, 'scheduleId', 'agent-daily-flow', 128);
  const taskFlow = input.taskFlow ?? null;
  if (taskFlow !== null && !Array.isArray(taskFlow)) {
    throw invalidRequest('AGENT_VALIDATION_TASK_FLOW_INVALID', 'taskFlow 必须是数组', {
      receivedType: typeof taskFlow
    });
  }

  return { dryRun, scheduleId, taskFlow, waitForCompletion };
}

export const COPILOT_SET_MODES = Object.freeze(['continuous', 'manual'] as const);

export type CopilotSetMode = (typeof COPILOT_SET_MODES)[number];
export type CopilotSetRaid = 'normal' | 'raid' | 'both';

const COPILOT_SET_RAIDS: ReadonlySet<string> = new Set<CopilotSetRaid>(['normal', 'raid', 'both']);

/**
 * `app` was page-driven sequential execution and `cli` was maa-cli's native
 * multi-copilot run. Both are now one server-held continuous queue.
 */
export function normalizeCopilotSetMode(value: unknown): CopilotSetMode {
  if (value === undefined || value === null || value === '') return 'continuous';
  if (value === 'continuous' || value === 'app' || value === 'cli') return 'continuous';
  if (value === 'manual') return 'manual';
  throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_MODE_INVALID', 'mode 必须是 continuous、app、cli 或 manual', {
    mode: value,
    allowed: ['continuous', 'app', 'cli', 'manual']
  });
}

/** 作业集执行请求：选择按非负整数收窄，`options` 原样交给计划域读取。 */
export interface NormalizedCopilotSetExecutionRequest {
  mode: CopilotSetMode;
  raid: CopilotSetRaid;
  selectedIndexes: number[];
  options: Record<string, unknown>;
  waitForCompletion: boolean;
}

export function normalizeCopilotSetExecutionRequest(input: unknown = {}): NormalizedCopilotSetExecutionRequest {
  if (!isRecord(input)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_INPUT_INVALID', '请求体必须是对象', {
      receivedType: receivedTypeOf(input)
    });
  }

  const mode = normalizeCopilotSetMode(input.mode);

  // The legacy endpoint treated any unknown raid value as normal; keep that
  // mapping so old callers are not rejected by the new validation.
  const raid: CopilotSetRaid = typeof input.raid === 'string' && COPILOT_SET_RAIDS.has(input.raid)
    ? input.raid as CopilotSetRaid
    : 'normal';

  const selectedIndexes = input.selectedIndexes ?? [];
  if (!Array.isArray(selectedIndexes)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_SELECTION_INVALID', 'selectedIndexes 必须是数组', {
      receivedType: typeof selectedIndexes
    });
  }
  const normalizedIndexes = selectedIndexes.map(Number);
  if (normalizedIndexes.some(index => !Number.isInteger(index) || index < 0)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_SELECTION_INVALID', 'selectedIndexes 只能包含非负整数', {
      selectedIndexes
    });
  }

  const options = input.options ?? {};
  if (!isRecord(options)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_OPTIONS_INVALID', 'options 必须是对象', {
      receivedType: Array.isArray(options) ? 'array' : typeof options
    });
  }

  const waitForCompletion = input.waitForCompletion ?? true;
  if (typeof waitForCompletion !== 'boolean') {
    throw invalidRequest('AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID', 'waitForCompletion 必须是布尔值', {
      receivedType: typeof waitForCompletion
    });
  }

  return { mode, raid, selectedIndexes: normalizedIndexes, options, waitForCompletion };
}

/**
 * Execute a command exposed through the Agent API after validating its
 * filesystem-sensitive dynamic-task inputs.
 */
export async function executeAgentTask(
  input: unknown = {},
  dependencies: AgentTaskDependencies = {}
): Promise<unknown> {
  const source = isRecord(input) ? input : {};
  const {
    command,
    args = [],
    taskConfig,
    taskName,
    taskType,
    waitForCompletion = true,
    userResource = false
  } = source;

  if (typeof command !== 'string' || !AGENT_TASK_COMMAND_SET.has(command)) {
    throw invalidRequest(
      'AGENT_VALIDATION_COMMAND_NOT_ALLOWED',
      `不允许的 command: ${textOf(command)}`,
      { command, allowed: [...AGENT_TASK_COMMANDS] }
    );
  }

  if (!Array.isArray(args)) {
    throw invalidRequest(
      'AGENT_VALIDATION_ARGS_INVALID',
      'args 必须是数组',
      { receivedType: receivedTypeOf(args) }
    );
  }

  if (typeof waitForCompletion !== 'boolean') {
    throw invalidRequest(
      'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID',
      'waitForCompletion 必须是布尔值',
      { receivedType: typeof waitForCompletion }
    );
  }

  if (typeof userResource !== 'boolean') {
    throw invalidRequest(
      'AGENT_VALIDATION_USER_RESOURCE_INVALID',
      'userResource 必须是布尔值',
      { receivedType: typeof userResource }
    );
  }

  const normalizedArgs = args.map(String);
  const normalizedTaskName = normalizeOptionalLabel(taskName, 'taskName', `Agent: ${command}`, 160);
  const normalizedTaskType = normalizeOptionalLabel(taskType, 'taskType', 'agent', 64);
  const hasTaskConfig = taskConfig !== undefined && taskConfig !== null;

  if (hasTaskConfig) {
    const normalizedTaskConfig = normalizeTaskConfig(taskConfig);
    const requestedTaskId = normalizedArgs[0]?.trim();
    const taskId = requestedTaskId || command;

    if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_ID_INVALID',
        '动态任务 ID 只能包含字母、数字、下划线和连字符',
        { taskId, pattern: SAFE_TASK_ID_PATTERN.source }
      );
    }

    if (typeof dependencies.execDynamicTask !== 'function') {
      throw new TypeError('executeAgentTask requires execDynamicTask');
    }

    return dependencies.execDynamicTask(
      taskId,
      normalizedTaskConfig,
      normalizedTaskName,
      normalizedTaskType,
      waitForCompletion,
      userResource
    );
  }

  if (typeof dependencies.execMaaCommand !== 'function') {
    throw new TypeError('executeAgentTask requires execMaaCommand');
  }

  if (AGENT_QUERY_COMMANDS.has(command)) {
    return dependencies.execMaaCommand(command, normalizedArgs, null, null, true);
  }

  return dependencies.execMaaCommand(
    command,
    normalizedArgs,
    normalizedTaskName,
    normalizedTaskType,
    waitForCompletion
  );
}

/**
 * 流程结果中只有 `success: false` 表示未开始；忙碌与其它拒绝分别映射到
 * 既有错误码。`result` 原样进入错误详情，供调用方排查。
 */
export function createDailyFlowExecutionError(result: unknown): AgentError | null {
  const source: Record<string, unknown> = isRecord(result) ? result : {};
  if (source.success !== false) return null;

  const rawMessage = source.message;
  const message = rawMessage ? textOf(rawMessage) : '今日流程未能开始执行';
  const isBusy = source.busy === true || message.includes('已有任务');

  if (isBusy) {
    return agentError('AGENT_EXECUTION_BUSY', message, {
      statusCode: 409,
      details: { owner: source.owner ?? null },
      retryable: true
    });
  }

  return agentError('AGENT_DAILY_FLOW_REJECTED', message, {
    statusCode: 400,
    details: { result },
    retryable: false
  });
}
