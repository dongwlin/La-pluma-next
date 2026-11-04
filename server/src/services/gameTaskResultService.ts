import {
  getCallbackDetails,
  getCallbackTaskName,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';
import type { MaaCallbackEvent } from './maaCallbackService.ts';

export type GameTaskType = 'OperProgress' | 'SwitchTheme';

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

function parseProgress(taskName: string, events: MaaCallbackEvent[]): GameTaskExecutionAction {
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
  const status = failed ? 'failed' : successCount === 0 && summary !== undefined ? 'skipped'
    : successCount === 0 && skippedCount > 0 ? 'skipped' : 'success';
  const message = failed
    ? `游戏内培养执行失败：${counts}${trainingMessage}`
    : summary ? `游戏内培养流程结束：${counts}${trainingMessage}`
      : `游戏内培养已观察到：${counts}，完整结果未确认${trainingMessage}`;
  return { ...base, status, message, successCount, failedCount, skippedCount, trainingStartedCount, details };
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
  logOutput: string | null | undefined = ''
): GameTaskExecutionAction {
  const events = parseMaaCallbackEvents(logOutput, taskType);
  return taskType === 'OperProgress' ? parseProgress(taskName, events) : parseTheme(taskName, events);
}
