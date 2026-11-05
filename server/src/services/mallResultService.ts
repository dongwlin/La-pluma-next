import {
  getCallbackDetails,
  getCallbackTaskName,
  getStartedTaskNames,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';
import type { MaaCallbackEvent } from './maaCallbackService.ts';

/** 信用收支任务的参数：三项都为严格 `false` 时整体跳过。 */
export interface MallTaskParams {
  visit_friends?: unknown;
  shopping?: unknown;
  credit_fight?: unknown;
  [extension: string]: unknown;
}

export interface MallExecutionAction {
  task: string;
  action: 'mall';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  visitedCount: number;
  creditCollected: boolean;
  purchasedCount: number;
  noMoney: boolean;
  visitLimited: boolean;
  noFriends: boolean;
}

function isMallDisabled(params: MallTaskParams): boolean {
  return params.visit_friends === false
    && params.shopping === false
    && params.credit_fight === false;
}

const VISIT_TASKS = new Set(['VisitNext', 'VisitNextOcr']);

function countVisits(startEvents: readonly MaaCallbackEvent[]): number {
  let count = 0;
  let previousTask: string | null = null;
  for (const event of startEvents) {
    if (event.callback !== 'SubTaskStart') continue;
    const task = getCallbackTaskName(event);
    if (!task || !VISIT_TASKS.has(task)) {
      previousTask = null;
      continue;
    }
    if (previousTask === null || task === previousTask) count++;
    previousTask = task;
  }
  return count;
}

export function parseMallExecutionAction(
  taskName: string,
  params: MallTaskParams = {},
  logOutput: string | null | undefined = ''
): MallExecutionAction {
  if (isMallDisabled(params)) {
    return {
      task: taskName,
      action: 'mall',
      status: 'skipped',
      visitedCount: 0,
      creditCollected: false,
      purchasedCount: 0,
      noMoney: false,
      visitLimited: false,
      noFriends: false,
      message: '未启用好友访问、信用购物或信用作战，已跳过'
    };
  }

  if (logOutput === null || logOutput === undefined) {
    return {
      task: taskName,
      action: 'mall',
      status: 'failed',
      visitedCount: 0,
      creditCollected: false,
      purchasedCount: 0,
      noMoney: false,
      visitLimited: false,
      noFriends: false,
      message: '无法读取信用收支执行日志，结果未确认'
    };
  }

  const events = parseMaaCallbackEvents(logOutput, 'Mall');
  if (events.length === 0) {
    return {
      task: taskName,
      action: 'mall',
      status: 'success',
      visitedCount: 0,
      creditCollected: false,
      purchasedCount: 0,
      noMoney: false,
      visitLimited: false,
      noFriends: false,
      message: '信用收支流程已完成'
    };
  }

  const startEvents = events.filter(event => event.callback === 'SubTaskStart');
  const taskNames = getStartedTaskNames(events);
  const visitedCount = countVisits(startEvents);
  const creditCollected = taskNames.includes('CollectCredit');
  const purchasedCount = startEvents.filter(event => {
    if (getCallbackTaskName(event) !== 'CreditShop-Bought') return false;
    const execTimes = getCallbackDetails(event)?.exec_times;
    return execTimes === undefined || Number(execTimes) === 1;
  }).length;
  const noMoney = taskNames.includes('CreditShop-NoMoney');
  const visitLimited = taskNames.includes('VisitLimited');
  const noFriends = taskNames.includes('NoFriends');
  const failed = events.some(event => event.callback === 'TaskChainError');
  const entered = taskNames.some(task => [
    'FriendsList',
    'StartToVisit',
    'Mall',
    'CreditStoreOcr',
    'CollectCredit',
    'CreditShop-BuyIt',
    'CreditShop-Bought'
  ].includes(task));
  const baseAction: Omit<MallExecutionAction, 'status' | 'message'> = {
    task: taskName,
    action: 'mall',
    visitedCount,
    creditCollected,
    purchasedCount,
    noMoney,
    visitLimited,
    noFriends
  };

  if (failed) {
    return {
      ...baseAction,
      status: 'failed',
      message: entered ? '信用收支处理过程中失败' : '未能进入或识别好友或信用商店界面'
    };
  }

  const details: string[] = [];
  if (visitedCount > 0) details.push(`访问 ${visitedCount} 位好友`);
  if (creditCollected) details.push('已领取信用');
  if (purchasedCount > 0) details.push(`购买 ${purchasedCount} 件商品`);
  if (noMoney) details.push('信用不足');
  if (visitLimited) details.push('好友访问已达上限');
  if (noFriends) details.push('暂无可访问好友');

  return {
    ...baseAction,
    status: 'success',
    message: details.length > 0
      ? `信用收支完成：${details.join('；')}`
      : '信用收支流程已完成'
  };
}
