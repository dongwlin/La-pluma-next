import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';

// 流程计划与命令构建：只处理任务流程数据，不读取设备连接、用户配置或通知状态。
// 连接默认值由调用方解析后传入，调度入口与确认接口共用同一份构建规则。
//
// 类型边界：
// - 任务流程来自持久配置或 HTTP 请求体，公开入口保持 `unknown`，先经
//   `validateScheduledTaskFlow` 收窄为“对象数组”，再按调度任务契约读取字段；
// - 校验只保证条目是对象，`id`/`name`/`params` 是执行期读取的契约字段，缺失时
//   沿用既有失败（例如 `id.split` 抛出的 TypeError），类型层不补默认值；
// - 参数值在构建时逐项按运行时类型分支处理，未知扩展字段原样保留；
// - 计划步骤是纯数据，可直接交给执行器或确认接口，不携带设备或存储句柄。

/** 流程中的关卡条目：字符串关卡或带开关的对象（智能养成、固定关卡）。 */
export interface ScheduledTaskStage {
  stage?: string;
  times?: string | number;
  smart?: boolean;
  pinned?: boolean;
  trainingOperators?: string[];
  [extension: string]: unknown;
}

export type ScheduledTaskStageEntry = string | ScheduledTaskStage;

/**
 * 任务参数：预定义命令使用的字段显式建模；MaaCore 动态任务参数由构建逻辑按
 * 运行时类型归一化，未建模的扩展字段仍原样保留。
 */
export interface ScheduledTaskParams {
  clientType?: string;
  accountName?: string;
  stage?: string;
  times?: string | number;
  stages?: ScheduledTaskStageEntry[];
  medicine?: string | number;
  expiringMedicine?: string | number;
  stone?: string | number;
  series?: string | number;
  drops?: string | Record<string, unknown>;
  DrGrandet?: boolean;
  report_to_penguin?: boolean;
  penguin_id?: string;
  report_to_yituliu?: boolean;
  yituliu_id?: string;
  recognizeDepotBeforeClose?: boolean;
  mode?: string | number;
  filename?: string;
  plan_index?: number;
  preserve_tags?: string | string[];
  skip_robot?: boolean;
  recruitment_time?: Record<string, string | number>;
  facility?: unknown[];
  award?: boolean;
  mail?: boolean;
  recruit?: boolean;
  orundum?: boolean;
  mining?: boolean;
  specialaccess?: boolean;
  visit_friends?: boolean;
  shopping?: boolean;
  credit_fight?: boolean;
  [extension: string]: unknown;
}

/**
 * 流程任务条目：`id`/`name`/`params` 是调度执行读取的契约字段。
 * 校验不是字段级 schema，缺失字段时的失败沿用执行期既有行为。
 */
export interface ScheduledTask {
  id: string;
  name: string;
  params: ScheduledTaskParams;
  commandId?: string;
  taskType?: string;
  enabled?: boolean;
  [extension: string]: unknown;
}

/** 解析连接参数时只需要地址；其余字段由调用方决定是否传递。 */
export interface ScheduleConnectionDefaults {
  address?: string;
  adbPath?: string;
  clientType?: string;
  profileId?: string;
}

/** 命令构建结果：`run` 表示动态任务，`taskConfig` 为序列化后的任务配置。 */
export interface ScheduledTaskCommand {
  command: string;
  params: string;
  taskConfig?: string;
}

/** 关闭游戏前的可见预动作；确认接口与执行计划共用。 */
export interface ScheduledTaskPreAction {
  action: 'depot-recognition';
}

/** 计划步骤：纯数据，不含设备或存储依赖。 */
export interface ScheduledTaskPlanStep {
  index: number;
  id: string;
  name: string;
  command: string;
  args: string[];
  dynamicTask: boolean;
  taskConfig?: Record<string, unknown>;
  preActions?: ScheduledTaskPreAction[];
}

export type ScheduledTaskFlowValidation =
  | { success: true }
  | { success: false; message: string; details?: { index: number } };

export type ScheduledTaskFlowPlanResult =
  | { success: true; totalSteps: number; steps: ScheduledTaskPlanStep[] }
  | { success: false; message: string; details?: { index: number } };

const commaSeparatedArrayKeys = new Set(['buy_first', 'blacklist', 'first_tags', 'preserve_tags']);

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDropTargetEntries(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];

  const rawEntries = typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).map(([itemId, count]) => `${itemId}=${count}`)
    : String(value).split(',').map(entry => entry.trim()).filter(Boolean);

  const normalizedEntries: string[] = [];
  for (const entry of rawEntries) {
    const match = entry.match(/^([A-Za-z0-9_-]+)\s*=\s*(\d+)$/);
    if (!match || Number(match[2]) <= 0) return null;
    normalizedEntries.push(`${match[1]}=${Number(match[2])}`);
  }
  return normalizedEntries;
}

/** 关卡条目归一化为 `stage`/`times`；无 stage 的条目保留为空串，由后续过滤丢弃。 */
interface NormalizedStageEntry {
  stage: string;
  times: string | number;
}

function normalizeStageEntry(entry: ScheduledTaskStageEntry): NormalizedStageEntry {
  if (typeof entry === 'string') return { stage: entry, times: '' };
  // 与既有构建一致：对象条目读取 stage；null 等无效条目按属性访问失败处理。
  if (typeof entry === 'object' && entry.stage) {
    return { stage: entry.stage, times: entry.times ?? '' };
  }
  return { stage: '', times: '' };
}

// 构建 MAA 命令
export function buildScheduledTaskCommand(
  task: ScheduledTask,
  connectionDefaults: ScheduleConnectionDefaults = {}
): ScheduledTaskCommand {
  if (task.taskType) {
    // MaaCore 内置任务类型
    const params: ScheduledTaskParams = { ...(task.params || {}) };
    if (task.taskType === 'Recruit') {
      if (params.preserve_tags === undefined && params.skip_robot === true) {
        params.preserve_tags = ['支援机械'];
      }
      if (params.recruitment_time && typeof params.recruitment_time === 'object') {
        params.recruitment_time = Object.fromEntries(
          Object.entries(params.recruitment_time).map(([level, minutes]) => [level, Number(minutes)])
        );
      }
      delete params.skip_robot;
    }
    if (task.taskType === 'Infrast' && Number(params.mode) === 10000 && !String(params.filename || '').trim()) {
      throw new Error('自定义换班需要填写排班文件路径');
    }
    if (task.taskType === 'Infrast' && Number(params.mode) === 10000 && params.plan_index === undefined) {
      params.plan_index = 0;
    }
    const taskConfigParams: Record<string, unknown> = {};
    const taskConfig = {
      name: task.name,
      type: task.taskType,
      params: taskConfigParams
    };

    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value === undefined || value === '' || value === null) return;

      if (typeof value === 'boolean') {
        taskConfigParams[key] = value;
      } else if (Array.isArray(value)) {
        if (value.length > 0) {
          taskConfigParams[key] = value;
        }
      } else if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
        taskConfigParams[key] = value.trim();
      } else if (typeof value === 'string' && (commaSeparatedArrayKeys.has(key) || (value.includes(',') && !value.includes('[')))) {
        taskConfigParams[key] = value.split(',').map(v => v.trim()).filter(v => v);
      } else if (typeof value === 'number') {
        taskConfigParams[key] = value;
      } else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
        taskConfigParams[key] = Number(value);
      } else if (value) {
        taskConfigParams[key] = value;
      }
    });

    return {
      command: 'run',
      params: task.commandId || task.id,
      taskConfig: JSON.stringify(taskConfig)
    };
  }

  // 预定义命令
  const commandId = task.commandId || task.id.split('-')[0];
  let params = '';
  const extraArgs: string[] = [];

  if (commandId === 'startup' || commandId === 'closedown') {
    params = task.params.clientType || DEFAULT_CLIENT_TYPE;
    const address = connectionDefaults.address;
    if (address) {
      extraArgs.push(`-a ${address}`);
    }
    // 添加账号切换参数
    if (commandId === 'startup' && task.params.accountName) {
      extraArgs.push(`--account-name ${task.params.accountName}`);
    }
  } else if (commandId === 'fight') {
    // 支持多个关卡（stages 数组，每个元素是 {stage, times}）或单个关卡（stage 字符串）
    const stages: ScheduledTaskStageEntry[] = task.params.stages
      || [{ stage: task.params.stage || '', times: task.params.times || '' }];

    // 构建关卡列表，格式：stage1:times1,stage2:times2
    const stageList = stages
      .map(normalizeStageEntry)
      .filter(entry => entry.stage && entry.stage.trim())
      .map(entry => {
        const stage = entry.stage.trim();
        const times = entry.times ? `:${entry.times}` : '';
        return `${stage}${times}`;
      })
      .join(',');

    params = stageList;

    if (task.params.medicine !== undefined && task.params.medicine !== '' && task.params.medicine !== null) {
      params += ` -m ${task.params.medicine}`;
    }
    if (task.params.expiringMedicine !== undefined && task.params.expiringMedicine !== '' && task.params.expiringMedicine !== null) {
      params += ` --expiring-medicine ${task.params.expiringMedicine}`;
    }
    if (task.params.stone !== undefined && task.params.stone !== '' && task.params.stone !== null) {
      params += ` --stone ${task.params.stone}`;
    }
    if (task.params.series !== undefined && task.params.series !== '' && task.params.series !== '1') {
      params += ` --series ${task.params.series}`;
    }
    const dropTargets = parseDropTargetEntries(task.params.drops);
    if (dropTargets === null) {
      throw new Error('掉落目标格式应为物品 ID=数量，多个目标用逗号分隔');
    }
    dropTargets.forEach(target => {
      params += ` -D${target}`;
    });
    if (task.params.clientType) {
      params += ` --client-type ${task.params.clientType}`;
    }
    if (task.params.DrGrandet) {
      params += ' --dr-grandet';
    }
    if (task.params.report_to_penguin) {
      params += ' --report-to-penguin';
      if (String(task.params.penguin_id || '').trim()) {
        params += ` --penguin-id ${String(task.params.penguin_id).trim()}`;
      }
    }
    if (task.params.report_to_yituliu) {
      params += ' --report-to-yituliu';
      if (String(task.params.yituliu_id || '').trim()) {
        params += ` --yituliu-id ${String(task.params.yituliu_id).trim()}`;
      }
    }
  }

  if (extraArgs.length > 0) {
    params = `${extraArgs.join(' ')} ${params}`;
  }

  return { command: commandId, params };
}

export function validateScheduledTaskFlow(taskFlow: unknown): ScheduledTaskFlowValidation {
  if (!Array.isArray(taskFlow)) {
    return { success: false, message: '任务流程格式无效' };
  }

  const flow: unknown[] = taskFlow;
  const invalidTaskIndex = flow.findIndex(task => !isRecordValue(task));
  if (invalidTaskIndex >= 0) {
    return {
      success: false,
      message: '任务流程中的每一项都必须是对象',
      details: { index: invalidTaskIndex }
    };
  }

  const invalidCustomInfrast = flow.find(task => {
    const entry = task as Record<string, unknown>;
    if (entry.enabled === false || entry.taskType !== 'Infrast') return false;
    const params = isRecordValue(entry.params) ? entry.params : null;
    return Number(params?.mode) === 10000 && !String(params?.filename || '').trim();
  });
  if (invalidCustomInfrast) {
    return { success: false, message: '自定义换班需要填写排班文件路径' };
  }

  const invalidFightDrops = flow.find(task => {
    const entry = task as Record<string, unknown>;
    if (entry.enabled === false) return false;
    const commandId = entry.commandId || String(entry.id || '').split('-')[0];
    if (commandId !== 'fight') return false;
    const params = isRecordValue(entry.params) ? entry.params : null;
    return parseDropTargetEntries(params?.drops) === null;
  });
  if (invalidFightDrops) {
    return { success: false, message: '掉落目标格式应为物品 ID=数量，多个目标用逗号分隔' };
  }

  return { success: true };
}

export function buildScheduledTaskFlowPlan(
  taskFlow: unknown,
  connectionDefaults: ScheduleConnectionDefaults = {}
): ScheduledTaskFlowPlanResult {
  const validation = validateScheduledTaskFlow(taskFlow);
  if (!validation.success) return validation;

  try {
    // 校验只保证条目是对象；字段级结构按调度任务契约读取，缺失字段沿用执行期失败。
    const flow = taskFlow as ScheduledTask[];
    const steps = flow
      .filter(task => task.enabled)
      .map((task, index): ScheduledTaskPlanStep => {
        const { command, params, taskConfig } = buildScheduledTaskCommand(task, connectionDefaults);
        const args = params ? params.split(' ').filter(Boolean) : [];
        return {
          index: index + 1,
          id: task.id,
          name: task.name || task.commandId || task.id,
          command,
          args,
          dynamicTask: Boolean(taskConfig),
          ...(taskConfig ? { taskConfig: JSON.parse(taskConfig) as Record<string, unknown> } : {}),
          ...(command === 'closedown' && task.params?.recognizeDepotBeforeClose === true
            ? { preActions: [{ action: 'depot-recognition' as const }] }
            : {})
        };
      });

    return { success: true, totalSteps: steps.length, steps };
  } catch (error) {
    return { success: false, message: errorMessageOf(error) };
  }
}
