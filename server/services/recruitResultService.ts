/**
 * 自动公招（Recruit）结果解析
 *
 * 类型边界：
 * - 回调事件经 `maaCallbackService` 校验后再读取：`what`、`details.task`、`details.tags`、
 *   `details.level` 逐字段收窄，缺字段或类型不符按“未观察到”处理，不会中断解析。
 * - 输出只描述本次公招步骤（`success`/`failed`/`skipped`），不是整个 Run 的终态；没有结构化
 *   回调（旧日志或增量日志不可用）时按“流程已完成”回退。
 */

import {
  getCallbackDetails,
  getCallbackStringField,
  getCallbackStringList,
  getStartedTaskNames,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';
import type { MaaCallbackEvent } from './maaCallbackService.ts';

/** 自动公招任务的参数：`preserve_tags` 支持数组或逗号分隔字符串，其余字段不参与解析。 */
export interface RecruitTaskParams {
  preserve_tags?: string | readonly string[] | null;
  [extension: string]: unknown;
}

/**
 * 公招结果：计数只在观察到回调事件时提供；旧日志回退（无事件）只返回
 * `task`/`action`/`status`/`message`，保持既有响应形状。
 */
export interface RecruitExecutionAction {
  task: string;
  action: 'recruit';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  startedCount?: number;
  collectedCount?: number;
  expeditedCount?: number;
  refreshCount?: number;
  highestLevel?: number;
  detectedTags?: string[];
  finalTags?: string[];
  preservedTags?: string[];
  noRefresh?: boolean;
}

function normalizePreserveTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(tag => tag.trim()).filter(Boolean);
  return String(value || '').split(',').map(tag => tag.trim()).filter(Boolean);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))];
}

function hasWhat(event: MaaCallbackEvent, what: string): boolean {
  return getCallbackStringField(event, 'what') === what;
}

/** 解析一次自动公招步骤的回调日志。 */
export function parseRecruitExecutionAction(
  taskName: string,
  params: RecruitTaskParams = {},
  logOutput: string | null | undefined = ''
): RecruitExecutionAction {
  const events = parseMaaCallbackEvents(logOutput, 'Recruit');
  if (events.length === 0) {
    return {
      task: taskName,
      action: 'recruit',
      status: 'success',
      message: '自动公招流程已完成'
    };
  }

  const taskNames = getStartedTaskNames(events);
  const detectedEvents = events.filter(event => hasWhat(event, 'RecruitTagsDetected'));
  const resultEvents = events.filter(event => hasWhat(event, 'RecruitResult'));
  const preservedEvents = events.filter(event => hasWhat(event, 'RecruitPreservedTag'));
  const refreshCount = events.filter(event => hasWhat(event, 'RecruitTagsRefreshed')).length;
  const startedCount = taskNames.filter(task => task === 'RecruitConfirm').length;
  const collectedCount = taskNames.filter(task => task === 'RecruitFinish').length;
  const expeditedCount = taskNames.filter(task => task === 'RecruitNowConfirm').length;
  const noPermit = taskNames.includes('RecruitNoPermit');
  const noRefresh = taskNames.includes('RecruitNoRefresh');
  const failed = events.some(event => event.callback === 'TaskChainError');
  const completed = events.some(event => event.callback === 'TaskChainCompleted');
  const detectedTags = uniqueStrings(
    detectedEvents.flatMap(event => getCallbackStringList(event, 'tags'))
  );
  const finalDetectedEvent = detectedEvents.at(-1);
  const finalTags = finalDetectedEvent ? uniqueStrings(getCallbackStringList(finalDetectedEvent, 'tags')) : [];
  const highestLevel = resultEvents.reduce(
    (highest, event) => Math.max(highest, Number(getCallbackDetails(event)?.level) || 0),
    0
  );
  const configuredPreserveTags = normalizePreserveTags(params.preserve_tags);
  const preservedDetectedTags = uniqueStrings(
    preservedEvents.flatMap(event => getCallbackStringList(event, 'tags'))
  );
  const preservedTags = configuredPreserveTags.filter(tag => preservedDetectedTags.includes(tag));
  const effectivePreservedTags = preservedTags.length > 0 ? preservedTags : preservedDetectedTags;

  const baseAction: Omit<RecruitExecutionAction, 'status' | 'message'> = {
    task: taskName,
    action: 'recruit',
    startedCount,
    collectedCount,
    expeditedCount,
    refreshCount,
    highestLevel,
    detectedTags,
    finalTags,
    preservedTags: effectivePreservedTags,
    noRefresh
  };

  if (failed) {
    return {
      ...baseAction,
      status: 'failed',
      message: detectedEvents.length > 0
        ? '自动公招在标签处理过程中失败'
        : '自动公招未能进入或识别公招界面'
    };
  }

  if (startedCount > 0 || collectedCount > 0 || expeditedCount > 0) {
    const operations: string[] = [];
    if (startedCount > 0) operations.push(`开始 ${startedCount} 次招募`);
    if (collectedCount > 0) operations.push(`收取 ${collectedCount} 次结果`);
    if (expeditedCount > 0) operations.push(`加急 ${expeditedCount} 次`);
    if (refreshCount > 0) operations.push(`刷新 ${refreshCount} 次`);
    if (highestLevel > 0) operations.push(`最高 ${highestLevel} 星组合`);
    if (finalTags.length > 0) operations.push(`最终标签：${finalTags.join('、')}`);

    return {
      ...baseAction,
      status: 'success',
      message: `公招处理完成：${operations.join('；')}`
    };
  }

  if (preservedEvents.length > 0) {
    return {
      ...baseAction,
      status: 'skipped',
      message: `发现保留标签 ${effectivePreservedTags.join('、') || '高价值标签'}，已保留该槽位`
    };
  }

  if (noPermit) {
    return {
      ...baseAction,
      status: 'skipped',
      message: '招聘许可不足，未开始新的公招'
    };
  }

  if (detectedEvents.length > 0) {
    return {
      ...baseAction,
      status: 'skipped',
      message: noRefresh
        ? '标签已识别，但没有可用刷新次数或未匹配自动确认条件'
        : '标签已识别，但未匹配自动确认条件，已保留槽位'
    };
  }

  return {
    ...baseAction,
    status: completed ? 'skipped' : 'success',
    message: completed ? '没有可处理的公招槽位，已跳过' : '自动公招流程已完成'
  };
}
