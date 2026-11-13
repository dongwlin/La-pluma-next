import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import {
  normalizeGameTaskParams,
  validateDynamicTaskClientType,
  validateGameTaskParams,
  validateGameTaskVariantParams,
  validateRoguelikeCommandArgs
} from './gameTaskConfigService.ts';
import { CopilotManagedFileInvalidError, validateManagedCopilotFileName } from './copilotFileService.ts';
import type { CopilotQueueEntryInput, CopilotRaidSelection } from './copilotPlanService.ts';

/** 仅列 maa-cli 子命令；Core 任务类型（Award/Depot/OperBox/Infrast/Recruit/Mall）走 run + taskConfig 动态通路。 */
export const AGENT_TASK_COMMANDS = Object.freeze([
  'startup',
  'closedown',
  'fight',
  'copilot',
  'ssscopilot',
  'paradoxcopilot',
  'roguelike',
  'reclamation',
  'activity',
  'run',
  'list'
] as const);

export type AgentTaskCommand = (typeof AGENT_TASK_COMMANDS)[number];

/** 动态 Core 任务唯一允许的 maa-cli 子命令；运行时与 manifest/OpenAPI 共用该值。 */
export const AGENT_TASK_DYNAMIC_COMMAND = 'run';

const AGENT_TASK_COMMAND_SET: ReadonlySet<string> = new Set(AGENT_TASK_COMMANDS);
const AGENT_QUERY_COMMANDS: ReadonlySet<string> = new Set(['activity', 'list']);
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_TASK_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** maa-cli 在多个 variants 同时匹配时的参数合并策略；默认 first。 */
export const AGENT_TASK_STRATEGIES = Object.freeze(['first', 'merge'] as const);

export type AgentTaskStrategy = (typeof AGENT_TASK_STRATEGIES)[number];

/** 上游 variants 项：condition 决定是否匹配，params 在匹配后合并进任务参数。 */
export interface AgentTaskVariant {
  condition?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface AgentTaskConfig extends Record<string, unknown> {
  name: string;
  type: string;
  params: Record<string, unknown>;
  strategy?: AgentTaskStrategy;
  variants?: AgentTaskVariant[];
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

export type AgentTaskDynamicBatchExecutor = (
  taskId: string,
  taskConfigs: readonly AgentTaskConfig[],
  taskName: string,
  taskType: string,
  waitForCompletion: boolean,
  userResource: boolean
) => Promise<unknown>;

export interface AgentTaskDependencies {
  execMaaCommand?: AgentTaskCommandExecutor;
  execDynamicTask?: AgentTaskDynamicExecutor;
  execDynamicTasks?: AgentTaskDynamicBatchExecutor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

const STRATEGY_SET: ReadonlySet<string> = new Set(AGENT_TASK_STRATEGIES);

function normalizeTaskVariants(value: unknown): AgentTaskVariant[] {
  if (!Array.isArray(value)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig.variants 必须是数组',
      { reason: 'variants_array_required', receivedType: receivedTypeOf(value) }
    );
  }

  return value.map((variant, variantIndex) => {
    if (!isRecord(variant)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        'taskConfig.variants 的每一项都必须是对象',
        { reason: 'variant_object_required', variantIndex, receivedType: receivedTypeOf(variant) }
      );
    }

    for (const key of Object.keys(variant)) {
      if (key !== 'condition' && key !== 'params') {
        throw invalidRequest(
          'AGENT_VALIDATION_TASK_CONFIG_INVALID',
          `taskConfig.variants[${variantIndex}] 不支持字段 ${key}`,
          { reason: 'variant_field_unknown', variantIndex, field: key, allowed: ['condition', 'params'] }
        );
      }
    }

    const condition = variant.condition;
    if (condition !== undefined && !isRecord(condition)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        'variant.condition 必须是对象',
        { reason: 'variant_condition_object_required', variantIndex, receivedType: receivedTypeOf(condition) }
      );
    }

    const params = variant.params;
    if (params !== undefined && !isRecord(params)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        'variant.params 必须是对象',
        { reason: 'variant_params_object_required', variantIndex, receivedType: receivedTypeOf(params) }
      );
    }

    return {
      ...(condition ? { condition } : {}),
      ...(params ? { params } : {})
    };
  });
}

function normalizeVariantsParams(
  type: string,
  variants: AgentTaskVariant[] | undefined
): AgentTaskVariant[] | undefined {
  if (!variants) return undefined;
  return variants.map((variant, variantIndex) => {
    if (!variant.params) return variant;
    const normalization = normalizeGameTaskParams(type, variant.params);
    if (normalization.error) {
      throw invalidRequest('AGENT_VALIDATION_TASK_CONFIG_INVALID', normalization.error, {
        reason: 'game_task_params_invalid',
        variantIndex
      });
    }
    return normalization.params === variant.params
      ? variant
      : { ...variant, params: normalization.params };
  });
}

function readTaskClientType(params: Record<string, unknown>): string | undefined {
  const value = params.client_type;
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function normalizeSingleTaskConfig(normalized: Record<string, unknown>, label: string): AgentTaskConfig {
  if ('condition' in normalized) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      `${label}.condition 必须放在 variants 项内`,
      { reason: 'condition_must_be_in_variants' }
    );
  }

  for (const key of Object.keys(normalized)) {
    if (key !== 'name' && key !== 'type' && key !== 'params' && key !== 'strategy' && key !== 'variants') {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        `${label} 不支持字段 ${key}`,
        { reason: 'task_field_unknown', field: key, allowed: ['name', 'type', 'params', 'strategy', 'variants'] }
      );
    }
  }

  if (typeof normalized.name !== 'string' || !normalized.name.trim()
    || typeof normalized.type !== 'string' || !normalized.type.trim()) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      `${label}.name 和 ${label}.type 必须是非空字符串`,
      { reason: 'name_and_type_required' }
    );
  }

  const normalizedType = normalized.type.trim();
  if (!SAFE_TASK_TYPE_PATTERN.test(normalizedType)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_TYPE_INVALID',
      `${label}.type 必须是 Core 任务类型标识（字母开头，仅含字母、数字和下划线）`,
      { type: normalized.type, pattern: SAFE_TASK_TYPE_PATTERN.source }
    );
  }

  const params = normalized.params;
  if (params !== undefined && !isRecord(params)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      `${label}.params 必须是对象`,
      { reason: 'params_object_required' }
    );
  }

  const normalizedParams = normalizeGameTaskParams(normalizedType, params ?? {});
  if (normalizedParams.error) {
    throw invalidRequest('AGENT_VALIDATION_TASK_CONFIG_INVALID', normalizedParams.error, {
      reason: 'game_task_params_invalid'
    });
  }

  const strategy = normalized.strategy;
  if (strategy !== undefined && (typeof strategy !== 'string' || !STRATEGY_SET.has(strategy))) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      `${label}.strategy 必须是 first 或 merge`,
      { reason: 'strategy_invalid', strategy, allowed: [...AGENT_TASK_STRATEGIES] }
    );
  }

  const variants = normalized.variants === undefined
    ? undefined
    : normalizeTaskVariants(normalized.variants);
  const normalizedVariants = normalizeVariantsParams(normalizedType, variants);

  const validationMessage = validateGameTaskParams(normalizedType, normalizedParams.params);
  if (validationMessage) {
    throw invalidRequest('AGENT_VALIDATION_TASK_CONFIG_INVALID', validationMessage, { reason: 'game_task_params_invalid' });
  }

  const variantValidation = validateGameTaskVariantParams(normalizedType, normalizedParams.params, normalizedVariants);
  if (variantValidation) {
    throw invalidRequest('AGENT_VALIDATION_TASK_CONFIG_INVALID', variantValidation.message, {
      reason: 'game_task_params_invalid',
      variantIndex: variantValidation.variantIndex
    });
  }

  const clientTypeConflict = validateDynamicTaskClientType(
    {
      type: normalizedType,
      params: normalizedParams.params,
      ...(normalizedVariants ? { variants: normalizedVariants } : {})
    },
    readTaskClientType(normalizedParams.params)
  );
  if (clientTypeConflict) {
    throw invalidRequest('AGENT_VALIDATION_TASK_CONFIG_INVALID', clientTypeConflict, {
      reason: 'client_type_conflict'
    });
  }

  return {
    ...normalized,
    name: normalized.name.trim(),
    type: normalizedType,
    params: normalizedParams.params,
    ...(strategy ? { strategy: strategy as AgentTaskStrategy } : {}),
    ...(normalizedVariants ? { variants: normalizedVariants } : {})
  };
}

function normalizeTaskBatch(normalized: Record<string, unknown>): AgentTaskConfig[] {
  if ('name' in normalized || 'type' in normalized) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig 不能同时包含单任务字段与 tasks',
      { reason: 'tasks_exclusive' }
    );
  }

  for (const key of Object.keys(normalized)) {
    if (key !== 'tasks') {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        `多任务 taskConfig 不支持字段 ${key}`,
        { reason: 'batch_field_unknown', field: key, allowed: ['tasks'] }
      );
    }
  }

  const tasks = normalized.tasks;
  if (!Array.isArray(tasks)) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig.tasks 必须是数组',
      { reason: 'tasks_array_required', receivedType: receivedTypeOf(tasks) }
    );
  }
  if (tasks.length === 0) {
    throw invalidRequest(
      'AGENT_VALIDATION_TASK_CONFIG_INVALID',
      'taskConfig.tasks 至少需要一项',
      { reason: 'tasks_empty' }
    );
  }

  return tasks.map((task, taskIndex) => {
    if (!isRecord(task)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_CONFIG_INVALID',
        'taskConfig.tasks 的每一项都必须是对象',
        { reason: 'task_object_required', taskIndex, receivedType: receivedTypeOf(task) }
      );
    }
    try {
      return normalizeSingleTaskConfig(task, `tasks[${taskIndex}]`);
    } catch (error) {
      if (!isRecord(error) || typeof error.code !== 'string') throw error;
      const details = isRecord(error.details) ? error.details : {};
      throw agentError(error.code, errorMessageOf(error) || '任务配置无效', {
        statusCode: typeof error.statusCode === 'number' ? error.statusCode : 400,
        details: { ...details, taskIndex },
        retryable: false
      });
    }
  });
}

function normalizeTaskConfig(taskConfig: unknown): { taskConfig?: AgentTaskConfig; taskConfigs?: AgentTaskConfig[] } {
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

  if ('tasks' in normalized) {
    return { taskConfigs: normalizeTaskBatch(normalized) };
  }
  return { taskConfig: normalizeSingleTaskConfig(normalized, 'taskConfig') };
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
export type CopilotSetRaid = CopilotRaidSelection;

const COPILOT_SET_RAIDS: ReadonlySet<string> = new Set<CopilotSetRaid>(['normal', 'raid', 'both', 'auto']);

export function normalizeCopilotSetMode(value: unknown): CopilotSetMode {
  if (value === undefined || value === null || value === '') return 'continuous';
  if (value === 'continuous' || value === 'app' || value === 'cli') return 'continuous';
  if (value === 'manual') return 'manual';
  throw invalidRequest('AGENT_VALIDATION_COPILOT_SET_MODE_INVALID', 'mode 必须是 continuous、app、cli 或 manual', {
    mode: value,
    allowed: ['continuous', 'app', 'cli', 'manual']
  });
}

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

export const COPILOT_QUEUE_MODES = Object.freeze(['continuous', 'manual'] as const);

export type CopilotQueueMode = (typeof COPILOT_QUEUE_MODES)[number];

export const COPILOT_QUEUE_FAILURE_POLICIES = Object.freeze(['stop', 'continue'] as const);

export type CopilotQueueFailurePolicy = (typeof COPILOT_QUEUE_FAILURE_POLICIES)[number];

export interface NormalizedCopilotQueueExecutionRequest {
  queueId: string;
  name: string;
  mode: CopilotQueueMode;
  failurePolicy: CopilotQueueFailurePolicy;
  entries: CopilotQueueEntryInput[];
  options: Record<string, unknown>;
  waitForCompletion: boolean;
}

const COPILOT_QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COPILOT_QUEUE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COPILOT_QUEUE_MAX_ENTRIES = 50;
const COPILOT_QUEUE_MAX_NAME_LENGTH = 128;
const COPILOT_QUEUE_DEFAULT_ID = 'copilot-queue';
const COPILOT_QUEUE_DEFAULT_NAME = '作业队列';

function normalizeCopilotQueueId(value: unknown): string {
  if (value === undefined || value === null || value === '') return COPILOT_QUEUE_DEFAULT_ID;
  if (typeof value !== 'string' || !COPILOT_QUEUE_ID_PATTERN.test(value.trim())) {
    throw invalidRequest(
      'AGENT_VALIDATION_COPILOT_QUEUE_ID_INVALID',
      'queueId 只能包含字母、数字、点、下划线与连字符，且以字母或数字开头',
      { reason: 'queue_id_invalid', queueId: value }
    );
  }
  return value.trim();
}

function normalizeCopilotQueueName(value: unknown): string {
  if (value === undefined || value === null) return COPILOT_QUEUE_DEFAULT_NAME;
  if (typeof value !== 'string') {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_NAME_INVALID', 'name 必须是字符串', {
      reason: 'name_not_string',
      receivedType: receivedTypeOf(value)
    });
  }
  const normalized = value.trim();
  if (normalized.length > COPILOT_QUEUE_MAX_NAME_LENGTH) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_NAME_INVALID', `name 长度不能超过 ${COPILOT_QUEUE_MAX_NAME_LENGTH} 个字符`, {
      reason: 'name_too_long',
      maxLength: COPILOT_QUEUE_MAX_NAME_LENGTH
    });
  }
  return normalized || COPILOT_QUEUE_DEFAULT_NAME;
}

function normalizeCopilotQueueMode(value: unknown): CopilotQueueMode {
  if (value === undefined || value === null || value === '') return 'continuous';
  if (value === 'continuous' || value === 'app' || value === 'cli') return 'continuous';
  if (value === 'manual') return 'manual';
  throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_MODE_INVALID', 'mode 必须是 continuous、app、cli 或 manual', {
    mode: value,
    allowed: ['continuous', 'app', 'cli', 'manual']
  });
}

function normalizeCopilotQueueFailurePolicy(value: unknown): CopilotQueueFailurePolicy {
  if (value === undefined || value === null || value === '') return 'stop';
  if (value === 'stop' || value === 'continue') return value;
  throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_FAILURE_POLICY_INVALID', 'failurePolicy 必须是 stop 或 continue', {
    failurePolicy: value,
    allowed: [...COPILOT_QUEUE_FAILURE_POLICIES]
  });
}

function normalizeCopilotQueueEntry(value: unknown, index: number): CopilotQueueEntryInput {
  if (!isRecord(value)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_ENTRY_INVALID', 'entries 每项必须是对象', {
      reason: 'entry_not_object',
      index
    });
  }
  const clientId = value.clientId;
  if (typeof clientId !== 'string' || !COPILOT_QUEUE_CLIENT_ID_PATTERN.test(clientId)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_CLIENT_ID_INVALID', 'clientId 格式无效', {
      reason: 'client_id_invalid',
      index,
      clientId
    });
  }
  const source = value.source;
  if (source !== 'prts' && source !== 'file') {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_SOURCE_INVALID', 'source 必须是 prts 或 file', {
      reason: 'source_invalid',
      index,
      source
    });
  }
  const mode = value.mode ?? 'normal';
  if (mode !== 'normal' && mode !== 'raid' && mode !== 'both' && mode !== 'auto') {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_ENTRY_MODE_INVALID', 'mode 必须是 normal、raid、both 或 auto', {
      reason: 'entry_mode_invalid',
      index,
      mode
    });
  }
  if (source === 'prts') {
    const copilotId = value.copilotId;
    if (typeof copilotId !== 'number' || !Number.isInteger(copilotId) || copilotId <= 0) {
      throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_COPILOT_ID_INVALID', 'copilotId 必须是正整数', {
        reason: 'copilot_id_invalid',
        index,
        copilotId
      });
    }
    return { clientId, source, copilotId, mode };
  }
  let filename: string;
  try {
    filename = validateManagedCopilotFileName(value.filename);
  } catch (error) {
    if (error instanceof CopilotManagedFileInvalidError) {
      throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_FILENAME_INVALID', error.message, {
        reason: error.reason,
        index,
        filename: value.filename
      });
    }
    throw error;
  }
  return { clientId, source, filename, mode };
}

export function normalizeCopilotQueueExecutionRequest(
  input: unknown = {}
): NormalizedCopilotQueueExecutionRequest {
  if (!isRecord(input)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_INPUT_INVALID', '请求体必须是对象', {
      reason: 'body_not_object',
      receivedType: receivedTypeOf(input)
    });
  }

  const queueId = normalizeCopilotQueueId(input.queueId);
  const name = normalizeCopilotQueueName(input.name);
  const mode = normalizeCopilotQueueMode(input.mode);
  const failurePolicy = normalizeCopilotQueueFailurePolicy(input.failurePolicy);

  const entries = input.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > COPILOT_QUEUE_MAX_ENTRIES) {
    throw invalidRequest(
      'AGENT_VALIDATION_COPILOT_QUEUE_ENTRIES_INVALID',
      `entries 必须是 1–${COPILOT_QUEUE_MAX_ENTRIES} 项的数组`,
      {
        reason: Array.isArray(entries) ? 'entries_length_invalid' : 'entries_not_array',
        maxEntries: COPILOT_QUEUE_MAX_ENTRIES
      }
    );
  }

  const seen = new Set<string>();
  const normalizedEntries: CopilotQueueEntryInput[] = [];
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeCopilotQueueEntry(entry, index);
    if (seen.has(normalized.clientId)) {
      throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_CLIENT_ID_DUPLICATE', 'clientId 必须唯一', {
        reason: 'duplicate_client_id',
        clientId: normalized.clientId,
        index
      });
    }
    seen.add(normalized.clientId);
    normalizedEntries.push(normalized);
  }

  const options = input.options ?? {};
  if (!isRecord(options)) {
    throw invalidRequest('AGENT_VALIDATION_COPILOT_QUEUE_OPTIONS_INVALID', 'options 必须是对象', {
      reason: 'options_not_object',
      receivedType: Array.isArray(options) ? 'array' : typeof options
    });
  }

  const waitForCompletion = input.waitForCompletion ?? true;
  if (typeof waitForCompletion !== 'boolean') {
    throw invalidRequest('AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID', 'waitForCompletion 必须是布尔值', {
      receivedType: typeof waitForCompletion
    });
  }

  return {
    queueId,
    name,
    mode,
    failurePolicy,
    entries: normalizedEntries,
    options,
    waitForCompletion
  };
}

export interface NormalizedAgentTaskRequest {
  command: AgentTaskCommand;
  args: string[];
  taskConfig?: AgentTaskConfig;
  taskConfigs?: AgentTaskConfig[];
  taskName: string;
  taskType: string;
  waitForCompletion: boolean;
  userResource: boolean;
}

/**
 * 创建 Run 之前完成的请求校验与归一化。manifest/OpenAPI 的 run_task schema
 * 与本函数共享命令、动态任务命令、任务类型与游戏任务参数规则。
 */
export function preflightAgentTaskRequest(input: unknown = {}): NormalizedAgentTaskRequest {
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
  const commandArgsError = validateRoguelikeCommandArgs(command, normalizedArgs);
  if (commandArgsError) {
    throw invalidRequest('AGENT_VALIDATION_TASK_ARGS_INVALID', commandArgsError, {
      reason: 'command_args_invalid',
      command
    });
  }
  const normalizedTaskName = normalizeOptionalLabel(taskName, 'taskName', `Agent: ${command}`, 160);
  const normalizedTaskType = normalizeOptionalLabel(taskType, 'taskType', 'agent', 64);
  const hasTaskConfig = taskConfig !== undefined;

  if (hasTaskConfig && command !== AGENT_TASK_DYNAMIC_COMMAND) {
    throw invalidRequest(
      'AGENT_VALIDATION_COMMAND_COMBINATION_INVALID',
      `taskConfig 仅支持 command=${AGENT_TASK_DYNAMIC_COMMAND}`,
      { reason: 'task_config_requires_dynamic_command', command, expectedCommand: AGENT_TASK_DYNAMIC_COMMAND }
    );
  }

  if (!hasTaskConfig && userResource) {
    throw invalidRequest(
      'AGENT_VALIDATION_COMMAND_COMBINATION_INVALID',
      `userResource 仅支持 command=${AGENT_TASK_DYNAMIC_COMMAND} 加 taskConfig 的动态任务`,
      { reason: 'user_resource_requires_task_config', command }
    );
  }

  let normalizedTaskConfig: AgentTaskConfig | undefined;
  let normalizedTaskConfigs: AgentTaskConfig[] | undefined;
  if (hasTaskConfig) {
    const normalizedConfig = normalizeTaskConfig(taskConfig);
    normalizedTaskConfig = normalizedConfig.taskConfig;
    normalizedTaskConfigs = normalizedConfig.taskConfigs;
    const requestedTaskId = normalizedArgs[0]?.trim();
    const taskId = requestedTaskId || command;

    if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
      throw invalidRequest(
        'AGENT_VALIDATION_TASK_ID_INVALID',
        '动态任务 ID 只能包含字母、数字、下划线和连字符',
        { taskId, pattern: SAFE_TASK_ID_PATTERN.source }
      );
    }
  }

  return {
    command: command as AgentTaskCommand,
    args: normalizedArgs,
    ...(normalizedTaskConfig ? { taskConfig: normalizedTaskConfig } : {}),
    ...(normalizedTaskConfigs ? { taskConfigs: normalizedTaskConfigs } : {}),
    taskName: normalizedTaskName,
    taskType: normalizedTaskType,
    waitForCompletion: AGENT_QUERY_COMMANDS.has(command) ? true : waitForCompletion,
    userResource
  };
}

/** 执行已通过 preflight 的请求；控制器在创建 Run 前复用同一份归一化结果。 */
export async function executePreflightAgentTask(
  request: NormalizedAgentTaskRequest,
  dependencies: AgentTaskDependencies = {}
): Promise<unknown> {
  const taskId = request.args[0]?.trim() || request.command;

  if (request.taskConfigs) {
    if (typeof dependencies.execDynamicTasks !== 'function') {
      throw new TypeError('executeAgentTask requires execDynamicTasks');
    }

    return dependencies.execDynamicTasks(
      taskId,
      request.taskConfigs,
      request.taskName,
      request.taskType,
      request.waitForCompletion,
      request.userResource
    );
  }

  if (request.taskConfig) {
    if (typeof dependencies.execDynamicTask !== 'function') {
      throw new TypeError('executeAgentTask requires execDynamicTask');
    }

    return dependencies.execDynamicTask(
      taskId,
      request.taskConfig,
      request.taskName,
      request.taskType,
      request.waitForCompletion,
      request.userResource
    );
  }

  if (typeof dependencies.execMaaCommand !== 'function') {
    throw new TypeError('executeAgentTask requires execMaaCommand');
  }

  if (AGENT_QUERY_COMMANDS.has(request.command)) {
    return dependencies.execMaaCommand(request.command, request.args, null, null, true);
  }

  return dependencies.execMaaCommand(
    request.command,
    request.args,
    request.taskName,
    request.taskType,
    request.waitForCompletion
  );
}

export async function executeAgentTask(
  input: unknown = {},
  dependencies: AgentTaskDependencies = {}
): Promise<unknown> {
  return executePreflightAgentTask(preflightAgentTaskRequest(input), dependencies);
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
