import {
  getCallbackTaskName,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';
import type { MaaCallbackEvent } from './maaCallbackService.ts';

export type AwardItemKey = 'award' | 'mail' | 'recruit' | 'orundum' | 'mining' | 'specialaccess';

export interface AwardItem {
  readonly key: AwardItemKey;
  readonly label: string;
  readonly beginTask: string;
  readonly claimedTasks: readonly string[];
}

/** 领取奖励任务的参数：只有严格等于 `true` 的开关才领取，其余字段不参与解析。 */
export interface AwardTaskParams {
  award?: unknown;
  mail?: unknown;
  recruit?: unknown;
  orundum?: unknown;
  mining?: unknown;
  specialaccess?: unknown;
}

export interface AwardExecutionAction {
  task: string;
  action: 'award';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  observed?: boolean;
}

const AWARD_ITEMS: readonly AwardItem[] = [
  {
    key: 'award',
    label: '日常与周常奖励',
    beginTask: 'AwardBegin',
    claimedTasks: ['ReceiveAward']
  },
  {
    key: 'mail',
    label: '邮件奖励',
    beginTask: 'MailBegin',
    claimedTasks: ['ReceiveMail']
  },
  {
    key: 'recruit',
    label: '限定池免费单抽',
    beginTask: 'RecruitingActivitiesBegin',
    claimedTasks: ['RecruitingActivitiesConfirm', 'RecruitingActivitiesRecruit']
  },
  {
    key: 'orundum',
    label: '合成玉活动奖励',
    beginTask: 'OrundumActivitiesBegin',
    claimedTasks: ['OrundumActivitiesChoose', 'OrundumActivitiesConfirm']
  },
  {
    key: 'mining',
    label: '采矿活动奖励',
    beginTask: 'MiningActivitiesBegin',
    claimedTasks: ['MiningActivities', 'MiningActivitiesConfirm']
  },
  {
    key: 'specialaccess',
    label: '周年赠送月卡',
    beginTask: 'SpecialAccessActivitiesBegin',
    claimedTasks: ['SpecialAccessActivitiesConfirm']
  }
];

function getEventFirstTasks(event: MaaCallbackEvent): string[] {
  const first = event.first;
  return Array.isArray(first)
    ? first.filter((item): item is string => typeof item === 'string')
    : [];
}

function belongsToItem(event: MaaCallbackEvent, item: AwardItem): boolean {
  return getEventFirstTasks(event).includes(item.beginTask);
}

export function getEnabledAwardItems(params: AwardTaskParams = {}): AwardItem[] {
  return AWARD_ITEMS.filter(item => params[item.key] === true);
}

/**
 * 解析领取步骤的结构化回调。
 *
 * - 未启用任何项目：单项 `skipped`；
 * - 日志不可用或没有结构化回调：`failed` 且 `observed: false`，不冒充已完成；
 * - 只有观察到领取任务的 `SubTaskCompleted` 才确认 `success`。
 */
export function parseAwardExecutionActions(
  taskName: string,
  params: AwardTaskParams = {},
  logOutput: string | null | undefined = ''
): AwardExecutionAction[] {
  const enabledItems = getEnabledAwardItems(params);
  if (enabledItems.length === 0) {
    return [{
      task: taskName,
      action: 'award',
      status: 'skipped',
      observed: false,
      message: '未启用任何领取项目，已跳过'
    }];
  }

  if (logOutput === null || logOutput === undefined || logOutput.trim() === '') {
    return [{
      task: taskName,
      action: 'award',
      status: 'failed',
      observed: false,
      message: `无法读取领取日志，${enabledItems.length} 项领取结果未确认`
    }];
  }

  const events = parseMaaCallbackEvents(logOutput, 'Award');
  if (events.length === 0) {
    return [{
      task: taskName,
      action: 'award',
      status: 'success',
      observed: false,
      message: `领取奖励流程已完成，共检查 ${enabledItems.length} 项（未观察到结构化回调，结果未确认）`
    }];
  }

  return enabledItems.map(item => {
    const scopedEvents = events.filter(event => belongsToItem(event, item));
    const claimed = scopedEvents.some(event => event.callback === 'SubTaskCompleted'
      && item.claimedTasks.includes(getCallbackTaskName(event) || ''));
    if (claimed) {
      return {
        task: taskName,
        action: 'award',
        status: 'success',
        observed: true,
        message: `${item.label}已领取`
      };
    }
    if (scopedEvents.length > 0) {
      return {
        task: taskName,
        action: 'award',
        status: 'skipped',
        observed: true,
        message: `${item.label}已执行领取步骤，但未观察到完成回调，结果未确认`
      };
    }
    return {
      task: taskName,
      action: 'award',
      status: 'failed',
      observed: false,
      message: `${item.label}未观察到领取回调，结果未确认`
    };
  });
}
