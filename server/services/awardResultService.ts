/**
 * 领取奖励（Award）结果解析
 *
 * 类型边界：
 * - 输入为命令日志文本：只读取 `first` 分段标记与 `"task"` 事件，不依赖 MaaCore 结构化回调；
 *   日志缺失或分段不完整时回退为“流程已完成”的检查结论。
 * - 输出只描述本次领取步骤的检查结果（`success`/`skipped`；执行异常由流程层以同一形状记录
 *   `failed`），不能当作整个 Run 的终态。
 */

/** 领取奖励的六个 MaaCore 开关。 */
export type AwardItemKey = 'award' | 'mail' | 'recruit' | 'orundum' | 'mining' | 'specialaccess';

/** 单个领取项目的日志分段定义。 */
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

/** 单个领取项目的检查结果。 */
export interface AwardExecutionAction {
  task: string;
  action: 'award';
  status: 'success' | 'failed' | 'skipped';
  message: string;
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
    label: '限定寻访奖励',
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
    label: '特别登录奖励',
    beginTask: 'SpecialAccessActivitiesBegin',
    claimedTasks: ['SpecialAccessActivitiesConfirm']
  }
];

function hasTaskEvent(logSegment: string, taskName: string): boolean {
  const escapedTaskName = taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"task":"${escapedTaskName}"`).test(logSegment);
}

function getTaskSegment(logOutput: string, item: AwardItem, nextItem: AwardItem | undefined): string | null {
  const startMarker = `"first":["${item.beginTask}"]`;
  const start = logOutput.indexOf(startMarker);
  if (start === -1) return null;

  if (!nextItem) return logOutput.slice(start);
  const nextMarker = `"first":["${nextItem.beginTask}"]`;
  const end = logOutput.indexOf(nextMarker, start + startMarker.length);
  return end === -1 ? logOutput.slice(start) : logOutput.slice(start, end);
}

/** 返回配置中严格启用（值为 `true`）的领取项目。 */
export function getEnabledAwardItems(params: AwardTaskParams = {}): AwardItem[] {
  return AWARD_ITEMS.filter(item => params[item.key] === true);
}

/**
 * 解析领取步骤的日志分段。
 *
 * - 未启用任何项目：单项 `skipped`；
 * - 分段缺失（旧日志或增量日志不可用）：回退为“流程已完成，共检查 N 项”的 `success`；
 * - 其余按各分段中是否出现领取任务事件区分 `success`/`skipped`。
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
      message: '未启用任何领取项目，已跳过'
    }];
  }

  const actions: AwardExecutionAction[] = [];
  let parsedItemCount = 0;
  const log = String(logOutput || '');

  enabledItems.forEach(item => {
    const itemIndex = AWARD_ITEMS.findIndex(candidate => candidate.key === item.key);
    const segment = getTaskSegment(log, item, AWARD_ITEMS[itemIndex + 1]);
    if (!segment) return;
    parsedItemCount++;

    const claimed = item.claimedTasks.some(claimedTask => hasTaskEvent(segment, claimedTask));
    actions.push({
      task: taskName,
      action: 'award',
      status: claimed ? 'success' : 'skipped',
      message: claimed
        ? `${item.label}已领取`
        : `${item.label}无可领取内容或当前未开放，已跳过`
    });
  });

  if (parsedItemCount === 0) {
    return [{
      task: taskName,
      action: 'award',
      status: 'success',
      message: `领取奖励流程已完成，共检查 ${enabledItems.length} 项`
    }];
  }

  return actions;
}
