import {
  getCallbackDetails,
  getCallbackTaskName,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';
import type { MaaCallbackEvent } from './maaCallbackService.ts';

export type GameTaskType = 'OperProgress' | 'SwitchTheme';

export interface GameTaskPlanTarget {
  name: string;
  role?: string;
  elite?: number;
  skillLevel?: number;
  skillMastery?: [number, number, number];
}

export interface GameTaskDeferredMastery {
  name: string;
  role?: string;
  skillMastery: [number, number, number];
}

export interface GameTaskDetail {
  name: string;
  role?: string;
  result: 'Success' | 'Failed' | 'Skipped';
  resultDetail: string;
  elite?: number;
  skillLevel?: number;
  skillMastery?: [number, number, number];
}

export interface GameTaskExecutionAction {
  task: string;
  action: 'operprogress' | 'switchtheme';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  observed: boolean;
  successCount?: number;
  failedCount?: number;
  skippedCount?: number;
  trainingStartedCount?: number;
  deferredCount?: number;
  deferredMastery?: GameTaskDeferredMastery[];
  theme?: string;
  details?: GameTaskDetail[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMastery(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(level => isCount(level) && level <= 3);
}

export function readOperProgressPlans(params: Record<string, unknown>): GameTaskPlanTarget[] {
  if (!Array.isArray(params.plans)) return [];
  const targets: GameTaskPlanTarget[] = [];
  for (const plan of params.plans) {
    if (!isRecord(plan) || typeof plan.name !== 'string' || !plan.name.trim()) continue;
    targets.push({
      name: plan.name,
      ...(typeof plan.role === 'string' && plan.role.trim() ? { role: plan.role } : {}),
      ...(isCount(plan.elite) ? { elite: plan.elite } : {}),
      ...(isCount(plan.skill_level) ? { skillLevel: plan.skill_level } : {}),
      ...(isMastery(plan.skill_mastery) ? { skillMastery: plan.skill_mastery } : {})
    });
  }
  return targets;
}

function parseProgressDetail(event: MaaCallbackEvent): GameTaskDetail | undefined {
  if (event.callback !== 'SubTaskExtraInfo' || event.what !== 'OperProgressDetail') return;
  const details = getCallbackDetails(event);
  if (!details || typeof details.name !== 'string' || !details.name.trim()
    || typeof details.result_detail !== 'string') return;

  const result = details.result;
  if (result !== 'Success' && result !== 'Failed' && result !== 'Skipped') return;
  return {
    name: details.name,
    ...(typeof details.role === 'string' ? { role: details.role } : {}),
    result,
    resultDetail: details.result_detail,
    ...(isCount(details.elite) && details.elite >= 1 && details.elite <= 2 ? { elite: details.elite } : {}),
    ...(isCount(details.skill_level) && details.skill_level >= 2 && details.skill_level <= 7
      ? { skillLevel: details.skill_level } : {}),
    ...(isMastery(details.skill_mastery) ? { skillMastery: details.skill_mastery } : {})
  };
}

function hasMasteryGoals(plan: GameTaskPlanTarget): boolean {
  return plan.skillMastery?.some(level => level > 0) === true;
}

function isMasteryTrigger(detail: GameTaskDetail): boolean {
  if (detail.resultDetail === 'TrainingRoomBusy') return true;
  return detail.skillMastery !== undefined
    && (detail.resultDetail === 'Completed' || detail.resultDetail === 'PrerequisiteTraining');
}

function resolveTriggerSlot(
  trigger: GameTaskDetail,
  configured: readonly number[],
  details: readonly GameTaskDetail[],
  triggerIndex: number
): number {
  if (trigger.skillMastery) return trigger.skillMastery.findIndex(level => level > 0);
  const covered = new Set<number>();
  for (const earlier of details.slice(0, triggerIndex)) {
    if (earlier.name !== trigger.name || !earlier.skillMastery) continue;
    earlier.skillMastery.forEach((level, slot) => {
      if (level > 0) covered.add(slot);
    });
  }
  return configured.findIndex((level, slot) => level > 0 && !covered.has(slot));
}

// Core 按计划顺序依次上报精英化、技能等级与专精明细，同一干员有多条计划时触发项只能按明细顺序归属。
function matchTriggerPlan(
  details: readonly GameTaskDetail[],
  plans: readonly GameTaskPlanTarget[],
  triggerIndex: number
): { planIndex: number; slot: number } | undefined {
  const trigger = details[triggerIndex];
  if (!trigger) return undefined;
  const sameNameDetailIndices: number[] = [];
  details.forEach((detail, index) => {
    if (detail.name === trigger.name) sameNameDetailIndices.push(index);
  });
  let cursor = 0;
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    const plan = plans[planIndex];
    if (!plan || plan.name !== trigger.name) continue;
    const otherDetailCount = (plan.elite === undefined ? 0 : 1) + (plan.skillLevel === undefined ? 0 : 1);
    for (let index = 0; index < otherDetailCount; index++) {
      const detailIndex = sameNameDetailIndices[cursor];
      if (detailIndex === undefined || detailIndex >= triggerIndex) return undefined;
      cursor++;
    }
    if (!plan.skillMastery) continue;
    for (let slot = 0; slot < plan.skillMastery.length; slot++) {
      if ((plan.skillMastery[slot] ?? 0) <= 0) continue;
      const detailIndex = sameNameDetailIndices[cursor];
      if (detailIndex === undefined || detailIndex > triggerIndex) return undefined;
      if (detailIndex === triggerIndex) return { planIndex, slot };
      cursor++;
    }
  }
  return undefined;
}

// Core 每轮只启动一项专精训练，后续专精目标不再发回调也不计数，只能结合配置计划与已观测回调反推。
function inferDeferredMastery(
  details: readonly GameTaskDetail[],
  plans: readonly GameTaskPlanTarget[]
): GameTaskDeferredMastery[] {
  if (!plans.some(hasMasteryGoals)) return [];
  const triggerIndex = details.findLastIndex(isMasteryTrigger);
  const trigger = triggerIndex < 0 ? undefined : details[triggerIndex];
  if (!trigger) return [];
  const matched = matchTriggerPlan(details, plans, triggerIndex);
  const planIndex = matched?.planIndex
    ?? plans.findLastIndex(plan => hasMasteryGoals(plan) && plan.name === trigger.name);
  const triggerPlan = planIndex < 0 ? undefined : plans[planIndex];
  if (!triggerPlan?.skillMastery) return [];
  const triggerSlot = matched?.slot
    ?? resolveTriggerSlot(trigger, triggerPlan.skillMastery, details, triggerIndex);

  const deferred: GameTaskDeferredMastery[] = [];
  for (let index = planIndex; index < plans.length; index++) {
    const plan = plans[index];
    if (!plan?.skillMastery) continue;
    const slots: [number, number, number] = [0, 0, 0];
    for (let slot = 0; slot < 3; slot++) {
      const level = plan.skillMastery[slot] ?? 0;
      if (level <= 0) continue;
      if (index === planIndex && (triggerSlot < 0 || slot <= triggerSlot)) continue;
      slots[slot] = level;
    }
    if (!slots.some(level => level > 0)) continue;
    deferred.push({
      name: plan.name,
      ...(typeof plan.role === 'string' && plan.role.trim() ? { role: plan.role } : {}),
      skillMastery: slots
    });
  }
  return deferred;
}

function parseProgress(taskName: string, events: MaaCallbackEvent[], plans: readonly GameTaskPlanTarget[]): GameTaskExecutionAction {
  const details = events.flatMap(event => {
    const detail = parseProgressDetail(event);
    return detail ? [detail] : [];
  });
  const summary = events.filter(event => event.callback === 'SubTaskExtraInfo'
    && event.what === 'OperProgressSummary').map(getCallbackDetails).filter(detail => detail
      && isCount(detail.success) && isCount(detail.failed) && isCount(detail.skipped)).at(-1);
  const detailFailed = details.filter(detail => detail.result === 'Failed').length;
  const failed = events.some(event => event.callback === 'TaskChainError') || detailFailed > 0
    || (summary !== undefined && isCount(summary.failed) && summary.failed > 0);
  const observed = failed || summary !== undefined;
  const base: GameTaskExecutionAction = {
    task: taskName,
    action: 'operprogress',
    status: failed ? 'failed' : 'success',
    observed,
    message: '游戏内培养进程已完成，游戏结果未确认'
  };
  if (!observed && details.length === 0) return base;

  const successCount = summary && isCount(summary.success)
    ? summary.success : details.filter(detail => detail.result === 'Success').length;
  const failedCount = Math.max(summary && isCount(summary.failed) ? summary.failed : 0, detailFailed);
  const skippedCount = summary && isCount(summary.skipped)
    ? summary.skipped : details.filter(detail => detail.result === 'Skipped').length;
  const trainingStartedCount = details.filter(detail => detail.result === 'Success'
    && (detail.resultDetail === 'PrerequisiteTraining'
      || (detail.resultDetail === 'Completed' && detail.skillMastery?.some(level => level > 0)))).length;
  const counts = `成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}`;
  const trainingMessage = trainingStartedCount > 0
    ? `；已启动 ${trainingStartedCount} 项专精训练，训练仍需游戏内时间` : '';
  const deferredMastery = inferDeferredMastery(details, plans);
  const deferredCount = deferredMastery.reduce(
    (total, plan) => total + plan.skillMastery.filter(level => level > 0).length,
    0
  );
  const deferredMessage = deferredCount > 0
    ? `；${deferredCount} 项专精目标本轮未执行，需后续运行` : '';
  const status = failed ? 'failed' : successCount === 0 && summary !== undefined ? 'skipped'
    : successCount === 0 && skippedCount > 0 ? 'skipped' : 'success';
  const countsMessage = failed
    ? `游戏内培养执行失败：${counts}${trainingMessage}`
    : summary ? `游戏内培养流程结束：${counts}${trainingMessage}`
      : `游戏内培养已观察到：${counts}，完整结果未确认${trainingMessage}`;
  const message = `${countsMessage}${deferredMessage}`;
  return {
    ...base,
    status,
    message,
    successCount,
    failedCount,
    skippedCount,
    trainingStartedCount,
    ...(deferredCount > 0 ? { deferredCount, deferredMastery } : {}),
    details
  };
}

function parseTheme(taskName: string, events: MaaCallbackEvent[]): GameTaskExecutionAction {
  const extraEvents = events.filter(event => event.callback === 'SubTaskExtraInfo');
  const completed = events.filter(event => event.callback === 'SubTaskCompleted');
  const notFound = extraEvents.find(event => event.what === 'SwitchThemeNotFound');
  const selected = completed.filter(event => getCallbackTaskName(event) === 'SwitchThemeByNameSelectTheme')
    .map(getCallbackDetails).map(detail => detail?.result).filter(isRecord).at(-1)?.text;
  const missingTheme = notFound ? getCallbackDetails(notFound)?.theme : undefined;
  const theme = typeof missingTheme === 'string' ? missingTheme
    : typeof selected === 'string' ? selected : undefined;
  const base = {
    task: taskName,
    action: 'switchtheme' as const,
    ...(theme ? { theme } : {})
  };
  const label = theme ? `“${theme}”` : '';
  if (events.some(event => event.callback === 'TaskChainError') || notFound) {
    return { ...base, status: 'failed', observed: true, message: notFound
      ? `未找到游戏界面主题${label}` : `游戏界面主题${label}更换失败` };
  }
  if (completed.some(event => getCallbackTaskName(event) === 'SwitchThemeByNameLockedTheme')) {
    return { ...base, status: 'failed', observed: true, message: `游戏界面主题${label}尚未解锁，未更换` };
  }
  if (extraEvents.some(event => event.what === 'SwitchThemeSkipped')) {
    return { ...base, status: 'skipped', observed: true, message: '没有候选游戏界面主题，已跳过' };
  }
  if (completed.some(event => getCallbackTaskName(event) === 'SwitchThemeByNameAlreadySet')) {
    return { ...base, status: 'success', observed: true, message: `游戏界面主题${label}已是当前主题` };
  }
  if (completed.some(event => getCallbackTaskName(event) === 'SwitchThemeByNameConfirmTheme')) {
    return { ...base, status: 'success', observed: true, message: `游戏界面主题${label}已更换` };
  }
  return { ...base, status: 'success', observed: false, message: '游戏界面主题更换进程已完成，游戏结果未确认' };
}

export function parseGameTaskExecutionAction(
  taskName: string,
  taskType: GameTaskType,
  logOutput: string | null | undefined = '',
  plans: readonly GameTaskPlanTarget[] = []
): GameTaskExecutionAction {
  const events = parseMaaCallbackEvents(logOutput, taskType);
  return taskType === 'OperProgress'
    ? parseProgress(taskName, events, plans)
    : parseTheme(taskName, events);
}
