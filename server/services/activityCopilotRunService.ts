import { loadUserConfig } from './configStorageService.ts';
import { findActivityCopilotCandidates } from './activityCopilotDiscoveryService.ts';
import type {
  ActivityCopilotCandidate,
  ActivityCopilotDiscoveryResult,
  ActivityCopilotSet
} from './activityCopilotDiscoveryService.ts';
import {
  buildCopilotPlan,
  ensureCurrentMapActivityResource,
  executeCopilotPlan,
  executeSelectedCopilotEntries
} from './copilotPlanService.ts';
import type {
  CopilotExecutionEntry,
  CopilotExecutionLifecycle,
  CopilotExecutionOptions,
  CopilotPlanRunResult,
  CopilotRaid,
  CopilotSelectedExecutionResult
} from './copilotPlanService.ts';
import type { ActivityNavigationActivity, ActivityNavigationResult } from './activityNavigationService.ts';
import { getMaaConfigDir } from './maaConfigService.ts';
import { updateMaaResources } from './resourceUpdateService.ts';
import type { ResourceUpdateResult } from './resourceUpdateService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { createCopilotProgressStore } from './copilotProgressStore.ts';
import { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * 活动作业执行：把候选发现结果收窄为执行计划，再交给作业集或已选条目执行。
 *
 * - 候选、持久进度与用户配置都按 unknown 收窄；本模块不重新发现候选，
 *   也不复制 MAA 执行状态。
 * - 计划构建是纯函数；设备副作用只发生在 `runCurrentActivityCopilots` 的
 *   兜底资源写入与实际执行（两者都在租约内或执行入口内）。
 * - 未选择或未就绪的计划不执行任何条目；完成进度只记录实际结算的条目。
 */

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
// 活动完成进度是共享 JSON 状态：读改写经进度存储按路径排队执行；
// 默认位置保持 server/data/activity-copilot-progress.json，可用环境变量注入隔离。
const activityProgressStore = createCopilotProgressStore({
  progressPath: process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE
    || join(dataDir, 'activity-copilot-progress.json')
});
const RESOURCE_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const resourceRefreshAttempts = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取结构化错误上的 message；非字符串按缺失处理。 */
function errorMessageOf(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.message !== 'string') return undefined;
  return error.message;
}

/** 活动预检中与刷新判断有关的字段；不要求完整预检结果。 */
export interface ActivityRefreshPreflight {
  reasonCode?: string | null;
  activity?: { code?: string | null } | null;
}

export function shouldRefreshActivityNavigation(
  preflight: ActivityRefreshPreflight | null | undefined = {},
  lastAttemptAt = 0,
  now = Date.now()
): boolean {
  return preflight?.reasonCode === 'navigation-resource-unavailable' &&
    Boolean(preflight?.activity?.code) &&
    now - lastAttemptAt >= RESOURCE_REFRESH_INTERVAL;
}

/** 活动完成度投影：只暴露本地进度能确认的关卡。 */
export interface ActivityCompletionSummary {
  known: boolean;
  complete: boolean;
  completedStages: string[];
  totalStages: number;
  source: 'local-activity-progress';
}

/** 活动代号在持久进度中的记录：关卡代号与最后一次写入时间。 */
export interface ActivityProgressEntry {
  stages: string[];
  updatedAt?: string;
}

/** 持久进度条目中的已完成关卡；非数组或非字符串条目按缺失处理。 */
function readCompletedStages(value: unknown): string[] {
  const entry = isRecord(value) ? value : {};
  return Array.isArray(entry.stages)
    ? entry.stages.filter((stage): stage is string => typeof stage === 'string')
    : [];
}

/** 读取单个活动代号的进度记录；非对象条目按缺失处理。 */
function readActivityProgressEntry(progress: unknown, code: string): ActivityProgressEntry | null {
  if (!isRecord(progress) || !isRecord(progress[code])) return null;
  const entry = progress[code];
  return {
    stages: readCompletedStages(entry),
    ...(isRecord(entry) && typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {})
  };
}

export function summarizeActivityCompletion(
  activity: unknown = {},
  progress: unknown = {}
): ActivityCompletionSummary {
  const info = isRecord(activity) ? activity : {};
  const stages = [...new Set((Array.isArray(info.stages) ? info.stages : [])
    .map(stage => String(stage || '').toUpperCase())
    .filter(Boolean))];
  const code = typeof info.code === 'string' ? info.code : '';
  if (!code || !stages.length) {
    return {
      known: false,
      complete: false,
      completedStages: [],
      totalStages: stages.length,
      source: 'local-activity-progress'
    };
  }
  const completedStages = readActivityProgressEntry(progress, code.toUpperCase())?.stages || [];
  return {
    known: true,
    complete: stages.every(stage => completedStages.includes(stage)),
    completedStages: stages.filter(stage => completedStages.includes(stage)),
    totalStages: stages.length,
    source: 'local-activity-progress'
  };
}

export async function getActivityCompletion(activity: unknown = {}): Promise<ActivityCompletionSummary> {
  return summarizeActivityCompletion(activity, await activityProgressStore.load());
}

/** 记录已完成条目；返回写回后的进度文档，其他活动代号的原始键原样保留。 */
export async function recordActivityCompletion(
  activity: unknown,
  entries: unknown
): Promise<Record<string, unknown>> {
  const activityRecord = isRecord(activity) ? activity : {};
  const code = String(activityRecord.code || '').toUpperCase();
  const list = Array.isArray(entries) ? entries : [];
  // 读改写当前文件内容后仅替换本活动代号的键，其他活动的进度不受影响；
  // 损坏文件报错且不清零。导出供回归测试直接验证读改写语义。
  return activityProgressStore.update(current => {
    const progress: Record<string, unknown> = isRecord(current) ? current : {};
    const existing = new Set(readCompletedStages(progress[code]));
    list.filter(entry => isRecord(entry) && entry.success !== false).forEach(entry => {
      const stage = isRecord(entry) ? entry.displayStage : undefined;
      if (typeof stage === 'string' && stage) existing.add(stage);
    });
    return { ...progress, [code]: { stages: [...existing].sort(), updatedAt: new Date().toISOString() } };
  });
}

function normalizeRaid(value: unknown): CopilotRaid {
  if (value === 'raid' || value === '1') return 'raid';
  if (value === 'both' || value === '2') return 'both';
  return 'normal';
}

/** 战斗配置中的作业偏好：原始值保持 unknown，由执行选项与任务参数各自收窄。 */
export interface CombatCopilotPreferences {
  raid: CopilotRaid;
  loopTimes: unknown;
  ignoreRequirements: boolean;
  useSanityPotion: boolean;
  addTrust: boolean;
  formationIndex: unknown;
  supportUsage: unknown;
  supportName: unknown;
  formationMode: unknown;
}

export function getCombatCopilotPreferences(combatTasks: unknown = {}): CombatCopilotPreferences {
  const tasks = isRecord(combatTasks) ? combatTasks : {};
  const advancedParams = isRecord(tasks.advancedParams) ? tasks.advancedParams : {};
  const preferences = isRecord(advancedParams.copilot) ? advancedParams.copilot : {};
  const autoFormation = isRecord(tasks.autoFormation) ? tasks.autoFormation : {};
  return {
    raid: normalizeRaid(preferences.raid),
    loopTimes: preferences.loopTimes || 1,
    ignoreRequirements: preferences.ignoreRequirements !== false,
    useSanityPotion: preferences.useSanityPotion === true,
    addTrust: preferences.addTrust === true,
    formationIndex: preferences.formationIndex,
    supportUsage: preferences.supportUsage,
    supportName: preferences.supportName,
    formationMode: autoFormation.copilot || 'auto'
  };
}

/** 单个活动的关卡候选：执行计划只取每关第一份可靠候选。 */
export interface ActivityStageCandidates {
  stage: string;
  candidates?: readonly ActivityCopilotCandidate[];
}

/** 执行计划依赖的候选发现投影：预检、关卡候选与可选的匹配作业集。 */
export interface ActivityCandidatePlan {
  state?: unknown;
  reason?: unknown;
  preflight: ActivityNavigationResult;
  stages: readonly ActivityStageCandidates[];
  matchingSet?: ActivityCopilotSet | null;
  navigationMode?: 'current-map-fallback' | 'home-navigation';
}

/** 活动作业执行条目：由候选收窄而来，交给已选条目执行入口。 */
export interface ActivityCopilotRunEntry extends CopilotExecutionEntry {
  copilotId: number;
  displayStage: string;
  mode: string;
  presetFormation: boolean;
  title: string;
  uri: string;
}

/** 未就绪的执行计划：原因必须能解释为何不执行任何条目。 */
export interface ActivityBlockedRunPlan {
  state: 'blocked';
  reason: string;
  entries: ActivityCopilotRunEntry[];
}

/** 就绪的执行计划：`activity` 与逐关条目可直接交给执行入口。 */
export interface ActivityReadyRunPlan {
  state: 'ready';
  reason: string;
  activity: ActivityNavigationActivity;
  entries: ActivityCopilotRunEntry[];
  navigationMode?: 'current-map-fallback' | 'home-navigation';
  requiresUserOnActivityMap?: boolean;
  currentMapResource?: { stageFile: string; stages: string[] };
  set?: ActivityCopilotSet | null;
  planId?: string;
}

export type ActivityCopilotRunPlan = ActivityBlockedRunPlan | ActivityReadyRunPlan;

/** 候选发现的读取结果：不可执行时 plan 为 blocked，不产生执行副作用。 */
export function buildActivityCopilotRunPlan(
  candidatePlan: ActivityCandidatePlan | null | undefined,
  preferences: { raid?: unknown } = {}
): ActivityCopilotRunPlan {
  if (candidatePlan?.state !== 'candidates-ready') {
    return {
      state: 'blocked',
      reason: typeof candidatePlan?.reason === 'string' && candidatePlan.reason
        ? candidatePlan.reason
        : '活动作业候选尚未就绪。',
      entries: []
    };
  }

  const missingStages = candidatePlan.stages.filter(stage => !stage.candidates?.length).map(stage => stage.stage);
  if (missingStages.length) {
    return {
      state: 'blocked',
      reason: `以下活动关卡没有可靠作业，未执行不完整流程：${missingStages.join('、')}`,
      entries: []
    };
  }

  const entries: ActivityCopilotRunEntry[] = [];
  const unsupportedRaidStages: string[] = [];
  for (const stage of candidatePlan.stages) {
    const candidate = stage.candidates?.[0];
    if (!candidate) continue;
    const requestedModes: string[] = preferences.raid === 'both'
      ? ['normal', 'raid']
      : [typeof preferences.raid === 'string' && preferences.raid ? preferences.raid : 'normal'];
    for (const mode of requestedModes) {
      if (mode === 'raid' && candidate.presetFormation) {
        if (preferences.raid === 'raid') unsupportedRaidStages.push(stage.stage);
        continue;
      }
      entries.push({
        copilotId: candidate.id,
        uri: candidate.uri,
        displayStage: stage.stage,
        mode,
        presetFormation: candidate.presetFormation === true,
        title: candidate.title
      });
    }
  }

  if (unsupportedRaidStages.length || !entries.length) {
    return {
      state: 'blocked',
      reason: unsupportedRaidStages.length
        ? `以下关卡只有预设编队作业，不能执行突袭：${unsupportedRaidStages.join('、')}`
        : '没有与当前作业偏好兼容的活动作业。',
      entries: []
    };
  }

  return {
    state: 'ready',
    reason: '已为每个当前活动关卡选择一份可靠作业，将按关卡顺序执行。',
    activity: candidatePlan.preflight.activity,
    entries
  };
}

/** 资源刷新结果：失败时保留 `error`，不把失败当成已刷新。 */
export interface ActivityResourceRefresh {
  attempted: true;
  output?: string;
  resource?: ResourceUpdateResult['resource'];
  error?: string;
}

interface ActivityRunBase {
  candidates: ActivityCopilotDiscoveryResult;
  preferences: CombatCopilotPreferences;
  resourceRefresh: ActivityResourceRefresh | null;
}

/** 未执行：`candidates` 与 `plan` 保留原因，调用方不应记录任何完成进度。 */
export interface ActivityRunNotExecuted extends ActivityRunBase {
  executed: false;
  plan: ActivityBlockedRunPlan;
}

/** 已执行：`execution` 为作业集或已选条目两条执行入口之一的原始结果。 */
export interface ActivityRunExecuted extends ActivityRunBase {
  executed: true;
  source: 'matching-set' | 'composed-candidates';
  plan: ActivityReadyRunPlan;
  execution: CopilotPlanRunResult | CopilotSelectedExecutionResult;
}

export type ActivityCopilotRunResult = ActivityRunNotExecuted | ActivityRunExecuted;

/** 作业集执行失败时，错误上附带已结算的逐项结果。 */
function readCopilotPlanResults(error: unknown): unknown[] {
  if (!isRecord(error)) return [];
  const copilotPlan = error.copilotPlan;
  if (!isRecord(copilotPlan) || !Array.isArray(copilotPlan.results)) return [];
  return copilotPlan.results;
}

export async function runCurrentActivityCopilots(
  clientType: string = DEFAULT_CLIENT_TYPE,
  lifecycle: CopilotExecutionLifecycle = {}
): Promise<ActivityCopilotRunResult> {
  let candidates = await findActivityCopilotCandidates(clientType, { allowCurrentMap: true });
  let resourceRefresh: ActivityResourceRefresh | null = null;
  const activityCode = String(candidates.preflight?.activity?.code || '').toUpperCase();
  const lastAttemptAt = resourceRefreshAttempts.get(`${clientType}:${activityCode}`) || 0;
  if (shouldRefreshActivityNavigation(candidates.preflight, lastAttemptAt)) {
    resourceRefreshAttempts.set(`${clientType}:${activityCode}`, Date.now());
    try {
      resourceRefresh = { attempted: true, ...(await updateMaaResources()) };
      candidates = await findActivityCopilotCandidates(clientType, { allowCurrentMap: true });
    } catch (error) {
      resourceRefresh = { attempted: true, error: errorMessageOf(error) };
    }
  }
  const configResult = await loadUserConfig('combat-tasks');
  const preferences = getCombatCopilotPreferences(configResult.success ? configResult.data : {});
  const plan = buildActivityCopilotRunPlan(candidates, preferences);
  if (plan.state !== 'ready') {
    return { executed: false, candidates, preferences, plan, resourceRefresh };
  }

  if (candidates.navigationMode === 'current-map-fallback') {
    plan.navigationMode = 'current-map-fallback';
    plan.requiresUserOnActivityMap = true;
    const configDir = (await getMaaConfigDir()).trim();
    plan.currentMapResource = await ensureCurrentMapActivityResource(
      configDir,
      plan.activity.code,
      plan.entries.map(entry => entry.displayStage)
    );
  }
  const executionOptions: CopilotExecutionOptions = candidates.navigationMode === 'current-map-fallback'
    ? { ...preferences, userResource: true }
    : preferences;

  if (candidates.matchingSet) {
    const setPlan = await buildCopilotPlan(candidates.matchingSet.id, preferences.raid);
    const activityStagePattern = new RegExp(
      `^${String(plan.activity.code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?:\\d+|EX-\\d+|S-\\d+|MO-\\d+|TR-\\d+)$`,
      'i'
    );
    const selectedIndexes = [...new Set(setPlan.entries
      .filter(entry => activityStagePattern.test(entry.displayStage))
      .map(entry => entry.itemIndex))];
    try {
      const execution = await executeCopilotPlan({
        setId: candidates.matchingSet.id,
        raid: preferences.raid,
        selectedIndexes,
        options: executionOptions,
        lifecycle
      });
      await recordActivityCompletion(plan.activity, plan.entries);
      return {
        executed: true,
        source: 'matching-set',
        candidates,
        preferences,
        plan: { ...plan, set: candidates.matchingSet },
        execution,
        resourceRefresh
      };
    } catch (error) {
      await recordActivityCompletion(plan.activity, readCopilotPlanResults(error));
      throw error;
    }
  }

  const planId = `activity-${plan.activity.code}-${Date.now()}`;
  const execution = await executeSelectedCopilotEntries({
    planId,
    name: `${plan.activity.name || plan.activity.code} 活动作业`,
    entries: plan.entries,
    options: executionOptions,
    lifecycle
  });
  await recordActivityCompletion(plan.activity, execution.results);
  return {
    executed: true,
    source: 'composed-candidates',
    candidates,
    preferences,
    plan: { ...plan, planId },
    execution,
    resourceRefresh
  };
}
