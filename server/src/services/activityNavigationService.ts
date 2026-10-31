import { readFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { getCurrentActivity } from './maaActivityService.ts';

/**
 * 活动预检：确认当前活动存在，且 MAA 资源包含从主页进入活动关卡的完整导航链。
 *
 * 活动来源与第三方关卡列表都按 unknown 收窄；预检只读取 MAA 资源目录
 * （`maa dir resource` 是非设备变更命令），不启动执行、不复制执行进度状态。
 */

/** 预检投影中的活动信息：无法确认的字段为 null，stages 只保留字符串关卡代号。 */
export interface ActivityNavigationActivity {
  code: string | null;
  name: string | null;
  source: string | null;
  stages: string[];
}

/** 就绪时的导航资源摘要：entryTask 是主页入口任务键。 */
export interface ActivityNavigationResource {
  source: 'maa-resource';
  stageFile: string;
  stageCount: number;
  entryTask: string;
}

/** 活动预检结果：ready 时 navigation 非空，blocked 时给出 reasonCode 与原因。 */
export interface ActivityNavigationResult {
  state: 'ready' | 'blocked';
  canPrepare: boolean;
  canRun: boolean;
  reasonCode: string | null;
  reason: string;
  activity: ActivityNavigationActivity;
  navigation: ActivityNavigationResource | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 活动对象按字段收窄；缺 code 视为无法确认活动，调用方据此返回 activity-unavailable。 */
function readActivity(value: unknown): ActivityNavigationActivity {
  if (!isRecord(value)) {
    return { code: null, name: null, source: null, stages: [] };
  }
  return {
    code: typeof value.code === 'string' && value.code ? value.code : null,
    name: typeof value.name === 'string' ? value.name : null,
    source: typeof value.source === 'string' ? value.source : null,
    stages: Array.isArray(value.stages)
      ? value.stages.filter((stage): stage is string => typeof stage === 'string')
      : []
  };
}

/** MAA 资源中的 next/sub 链接只认字符串条目；其他类型不构成导航链。 */
function toStringList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.filter((entry): entry is string => typeof entry === 'string');
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function blocked(
  activity: ActivityNavigationActivity,
  reasonCode: string,
  reason: string
): ActivityNavigationResult {
  return {
    state: 'blocked',
    canPrepare: false,
    canRun: false,
    reasonCode,
    reason,
    activity: {
      code: activity.code,
      name: activity.name,
      source: activity.source,
      stages: activity.stages
    },
    navigation: null
  };
}

/**
 * Checks that an activity's MAA stage file contains a complete home-screen
 * navigation chain. A stage list from a third-party source alone is not enough
 * to safely navigate the game UI.
 */
export function assessActivityNavigation(activity: unknown, tasks: unknown): ActivityNavigationResult {
  const info = readActivity(activity);
  const code = String(info.code || '').trim().toUpperCase();
  if (!code) {
    return blocked(info, 'activity-unavailable', '无法确认当前活动，未准备活动作业。');
  }
  if (!/^[A-Z0-9]{2,8}$/.test(code)) {
    return blocked(info, 'activity-code-invalid', '当前活动代号格式异常，未准备活动作业。');
  }
  if (!isRecord(tasks)) {
    return blocked(info, 'navigation-resource-unavailable', `未找到 ${code} 的活动导航资源。`);
  }

  const openOptionKey = `${code}-OpenOpt`;
  const openOption = tasks[openOptionKey];
  const openKeys = [`${code}-OpenOcr`, `${code}-Open`];
  const openKey = openKeys.find(key => Boolean(tasks[key]));

  const stagePattern = new RegExp(`^${code}-(?:\\d+|EX-\\d+|S-\\d+|MO-\\d+|TR-\\d+)$`, 'i');
  const stageEntries = Object.entries(tasks).filter(
    (entry): entry is [string, Record<string, unknown>] => stagePattern.test(entry[0]) && isRecord(entry[1])
  );

  const hasOpenSequence = Boolean(openOption && openKey &&
    toStringList(readProperty(openOption, 'next')).some(next => openKeys.includes(next)) &&
    toStringList(readProperty(tasks[openKey], 'next')).length > 0);
  const hasStageEntry = stageEntries.some(([, task]) =>
    toStringList(task.sub).includes(openOptionKey) && toStringList(task.next).length > 0
  );

  if (!hasOpenSequence || !hasStageEntry) {
    return blocked(
      info,
      'navigation-incomplete',
      `${code} 的资源未包含从主页进入活动关卡的完整导航链，未准备活动作业。`
    );
  }

  return {
    state: 'ready',
    canPrepare: true,
    canRun: false,
    reasonCode: null,
    reason: '已确认当前活动和从主页进入活动关卡的导航资源；此接口不会启动作业。',
    activity: {
      code,
      name: info.name || code,
      source: info.source,
      stages: info.stages
    },
    navigation: {
      source: 'maa-resource',
      stageFile: `tasks/Stages/${code}.json`,
      stageCount: stageEntries.length,
      entryTask: openOptionKey
    }
  };
}

/** 读取 MAA 资源中的活动关卡文件；文件内容按 unknown 交给预检收窄。 */
async function loadActivityStageTasks(code: string): Promise<unknown> {
  const resourceDir = (await execMaaCommand('dir', ['resource'], null, null, false, true)).stdout.trim();
  if (!resourceDir) throw new Error('无法读取 MAA 资源目录');
  const stageFile = join(resourceDir, 'tasks', 'Stages', `${code}.json`);
  const parsed: unknown = JSON.parse(await readFile(stageFile, 'utf8'));
  return parsed;
}

/** 当前活动预检；活动查询失败或缺少代号时直接返回 blocked，不读取资源文件。 */
export async function getActivityRunPreflight(
  clientType: string = DEFAULT_CLIENT_TYPE
): Promise<ActivityNavigationResult> {
  const activity = await getCurrentActivity(clientType);
  if (!activity?.code) return assessActivityNavigation(activity, null);

  try {
    const tasks = await loadActivityStageTasks(String(activity.code).toUpperCase());
    return assessActivityNavigation(activity, tasks);
  } catch {
    return blocked(
      readActivity(activity),
      'navigation-resource-unavailable',
      `未找到 ${activity.code} 的活动导航资源，未准备活动作业。`
    );
  }
}
