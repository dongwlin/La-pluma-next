import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { normalizeGameTaskParams, validateGameTaskParams } from './gameTaskConfigService.ts';

// 流程计划与命令构建：只处理任务流程数据，不读取设备连接、用户配置或通知状态。
// 公开入口保持 `unknown`，只校验到“对象数组”，字段级结构按调度任务契约在执行期读取，
// 缺失字段沿用既有失败；参数值逐项按运行时类型归一化、未知扩展字段原样保留，计划步骤是纯数据。

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
  start_game_enabled?: boolean;
  stage?: string;
  times?: string | number;
  stages?: ScheduledTaskStageEntry[];
  medicine?: string | number;
  medicineExpireDays?: string | number;
  /** @deprecated 旧版按瓶数设置的临期药，迁移后由 medicineExpireDays 取代。 */
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
  recognizeOperBoxBeforeClose?: boolean;
  mode?: string | number;
  filename?: string;
  plan_index?: number;
  preserve_tags?: string | string[];
  skip_robot?: boolean;
  level3_recruitment_permit_reserve?: string | number;
  extra_tags_mode?: string | number;
  force_refresh?: boolean;
  recruitment_time?: Record<string, string | number>;
  facility?: unknown[];
  award?: boolean;
  mail?: boolean;
  recruit?: boolean;
  orundum?: boolean;
  mining?: boolean;
  specialaccess?: boolean;
  signinevent?: boolean;
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

export interface ScheduledTaskPreAction {
  action: 'depot-recognition' | 'operbox-recognition';
}

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

/**
 * Core 里只有这些字段是「逗号分隔的数组字符串」；其余字符串按原值下发。
 * 不能按「凡是逗号就 split」处理：Infrast 的 `filename` 是排班文件路径，
 * 文件名本身可以带逗号（例如 `贸易,制造.json`），拆成数组后 maa-cli 在
 * 解析任务配置时报 `filename must be a string`。
 */
const commaSeparatedArrayKeys = new Set(['buy_first', 'blacklist', 'first_tags', 'preserve_tags']);

/**
 * 这些字段的空数组在 Core 侧有含义，不能按「空即省略」丢弃：Recruit 的
 * `select`/`confirm` 缺键时 `RecruitTask::set_params` 直接失败，空 `confirm`
 * 表示只计算标签不确认招募；Infrast 的 `facility` 缺键同样失败。
 * `plans`/`themes` 沿用既有的保留行为。
 */
const emptyArrayParamKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Infrast: Object.freeze(['facility']),
  OperProgress: Object.freeze(['plans']),
  Recruit: Object.freeze(['confirm', 'select']),
  SwitchTheme: Object.freeze(['themes'])
});

function keepsEmptyArray(taskType: string | undefined, key: string): boolean {
  return taskType !== undefined && (emptyArrayParamKeys[taskType]?.includes(key) ?? false);
}

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

interface TaskTypeSource {
  taskType?: unknown;
  commandId?: unknown;
  id?: unknown;
}

/** 预定义命令对应的 Core 任务类型；只有这些类型有可复用的参数约束。 */
function resolveTaskValidationType(task: TaskTypeSource): string | null {
  if (typeof task.taskType === 'string' && task.taskType) return task.taskType;
  const commandId = typeof task.commandId === 'string'
    ? task.commandId
    : String(task.id || '').split('-')[0];
  if (commandId === 'fight') return 'Fight';
  if (commandId === 'startup') return 'StartUp';
  return null;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function normalizeStartUpParams(params: ScheduledTaskParams): Record<string, unknown> {
  const dynamicParams: Record<string, unknown> = {};
  if (params.start_game_enabled !== undefined) dynamicParams.start_game_enabled = params.start_game_enabled;
  if (params.accountName) dynamicParams.account_name = params.accountName;
  if (params.clientType) dynamicParams.client_type = params.clientType;
  return dynamicParams;
}

export function buildScheduledTaskCommand(
  task: ScheduledTask,
  connectionDefaults: ScheduleConnectionDefaults = {}
): ScheduledTaskCommand {
  const validationType = resolveTaskValidationType(task);
  const normalizedParams = normalizeGameTaskParams(validationType ?? '', task.params || {});
  if (normalizedParams.error) throw new Error(normalizedParams.error);
  if (validationType) {
    const validationMessage = validateGameTaskParams(validationType, normalizedParams.params);
    if (validationMessage) throw new Error(validationMessage);
  }

  if (task.taskType) {
    const params: ScheduledTaskParams = { ...normalizedParams.params };
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

    if (task.taskType === 'StartUp') {
      Object.assign(taskConfigParams, normalizeStartUpParams(params));
    } else {
      Object.keys(params).forEach(key => {
        const value = params[key];
        if (value === undefined || value === '' || value === null) return;

        if (typeof value === 'boolean') {
          taskConfigParams[key] = value;
        } else if (Array.isArray(value)) {
          if (value.length > 0 || keepsEmptyArray(task.taskType, key)) {
            taskConfigParams[key] = value;
          }
        } else if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
          taskConfigParams[key] = value.trim();
        } else if (typeof value === 'string' && commaSeparatedArrayKeys.has(key)) {
          taskConfigParams[key] = value.split(',').map(v => v.trim()).filter(v => v);
        } else if (typeof value === 'number') {
          taskConfigParams[key] = value;
        } else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
          taskConfigParams[key] = Number(value);
        } else if (value) {
          taskConfigParams[key] = value;
        }
      });
    }

    return {
      command: 'run',
      params: task.commandId || task.id,
      taskConfig: JSON.stringify(taskConfig)
    };
  }

  const commandId = task.commandId || task.id.split('-')[0];

  // `maa startup` 只能启动游戏；关闭启动开关时改走 MaaCore StartUp 动态任务。
  if (commandId === 'startup' && task.params.start_game_enabled === false) {
    return {
      command: 'run',
      params: task.commandId || task.id,
      taskConfig: JSON.stringify({
        name: task.name,
        type: 'StartUp',
        params: normalizeStartUpParams(task.params)
      })
    };
  }

  let params = '';
  const extraArgs: string[] = [];

  if (commandId === 'startup' || commandId === 'closedown') {
    params = task.params.clientType || DEFAULT_CLIENT_TYPE;
    const address = connectionDefaults.address;
    if (address) {
      extraArgs.push(`-a ${address}`);
    }
    if (commandId === 'startup' && task.params.accountName) {
      extraArgs.push(`--account-name ${task.params.accountName}`);
    }
  } else if (commandId === 'fight') {
    const stages: ScheduledTaskStageEntry[] = task.params.stages
      || [{ stage: task.params.stage || '', times: task.params.times || '' }];

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
    if (isPresent(task.params.medicineExpireDays)) {
      params += ` --medicine-expire-days ${task.params.medicineExpireDays}`;
    } else if (isPresent(task.params.expiringMedicine)) {
      // 旧草稿仍按瓶数保存；maa-cli 保留了该隐藏选项以兼容旧配置。
      params += ` --expiring-medicine ${task.params.expiringMedicine}`;
    }
    if (task.params.stone !== undefined && task.params.stone !== '' && task.params.stone !== null) {
      params += ` --stone ${task.params.stone}`;
    }
    if (task.params.series !== undefined && task.params.series !== '' && task.params.series !== '1') {
      // maa-cli 用 clap 解析选项，空格分隔的负数会被当成未知选项（如 `--series -1`），
      // 统一用 `=` 连接，`-1`（禁用连战切换）才能正常下发。
      params += ` --series=${task.params.series}`;
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

  for (const task of flow) {
    const entry = task as Record<string, unknown>;
    if (entry.enabled === false) continue;
    const validationType = resolveTaskValidationType(entry);
    if (!validationType) continue;
    const normalizedParams = normalizeGameTaskParams(
      validationType,
      isRecordValue(entry.params) ? entry.params : {}
    );
    if (normalizedParams.error) return { success: false, message: normalizedParams.error };
    const message = validateGameTaskParams(validationType, normalizedParams.params);
    if (message) return { success: false, message };
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

function buildClosedownPreActions(params: ScheduledTaskParams | undefined): ScheduledTaskPreAction[] {
  const preActions: ScheduledTaskPreAction[] = [];
  if (params?.recognizeDepotBeforeClose === true) preActions.push({ action: 'depot-recognition' });
  if (params?.recognizeOperBoxBeforeClose === true) preActions.push({ action: 'operbox-recognition' });
  return preActions;
}

export function buildScheduledTaskFlowPlan(
  taskFlow: unknown,
  connectionDefaults: ScheduleConnectionDefaults = {}
): ScheduledTaskFlowPlanResult {
  const validation = validateScheduledTaskFlow(taskFlow);
  if (!validation.success) return validation;

  try {
    const flow = taskFlow as ScheduledTask[];
    const steps = flow
      .filter(task => task.enabled)
      .map((task, index): ScheduledTaskPlanStep => {
        const { command, params, taskConfig } = buildScheduledTaskCommand(task, connectionDefaults);
        const args = params ? params.split(' ').filter(Boolean) : [];
        const preActions = command === 'closedown' ? buildClosedownPreActions(task.params) : [];
        return {
          index: index + 1,
          id: task.id,
          name: task.name || task.commandId || task.id,
          command,
          args,
          dynamicTask: Boolean(taskConfig),
          ...(taskConfig ? { taskConfig: JSON.parse(taskConfig) as Record<string, unknown> } : {}),
          ...(preActions.length > 0 ? { preActions } : {})
        };
      });

    return { success: true, totalSteps: steps.length, steps };
  } catch (error) {
    return { success: false, message: errorMessageOf(error) };
  }
}
