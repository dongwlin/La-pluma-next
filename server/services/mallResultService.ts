/**
 * 信用收支（Mall）结果解析
 *
 * 类型边界：
 * - 参数来自未校验的任务配置：好友访问、信用购物、信用作战只有严格 `false` 才算关闭。
 * - 回调事件经 `maaCallbackService` 校验后再读取：任务名逐字段收窄，`exec_times` 缺失按单次
 *   计；缺字段或类型不符按“未观察到”处理。
 * - 输出只描述本次信用收支步骤（`success`/`failed`/`skipped`），不是整个 Run 的终态。
 */

import {
  getCallbackDetails,
  getCallbackTaskName,
  getStartedTaskNames,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';

/** 信用收支任务的参数：三项都为严格 `false` 时整体跳过。 */
export interface MallTaskParams {
  visit_friends?: unknown;
  shopping?: unknown;
  credit_fight?: unknown;
  [extension: string]: unknown;
}

/** 信用收支结果：计数与布尔只在回调可观察时置位。 */
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

/** 解析一次信用收支步骤的回调日志。 */
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
  const visitedCount = taskNames.filter(task => task === 'VisitNext' || task === 'VisitNextOcr').length;
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
