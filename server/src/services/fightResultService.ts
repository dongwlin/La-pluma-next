/**
 * 作战（Fight）结果解析
 *
 * 类型边界：
 * - 输入是任务总结、命令输出与错误对象等外部数据：总结字段逐个按 `unknown` 收窄，缺失或
 *   类型不符回落到 0/空串；错误对象只读取 `message`/`stdout`/`stderr` 文本。
 * - 输出只描述本次作战步骤（`success`/`skipped`/`failed`），就算理智耗尽也只是步骤结论，
 *   整个 Run 的终态仍由 Run 记录。
 */

/** 作战任务总结：来自 `parseTaskSummary`，旧格式或缺字段时各字段可缺省。 */
export interface FightTaskSummary {
  stage?: unknown;
  times?: unknown;
  drops?: unknown;
  dropItems?: unknown;
  medicine?: unknown;
  stone?: unknown;
  duration?: unknown;
  [extension: string]: unknown;
}

/** 作战步骤的输入：总结、命令输出、错误与外部跳过原因。 */
export interface FightActionOptions {
  summary?: FightTaskSummary | null;
  output?: string | null;
  error?: unknown;
  skipReason?: string | null;
}

/** 作战结果：数量、理智与掉落只在可观察时置位。 */
export interface FightExecutionAction {
  task: string;
  action: 'fight';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  stage: string;
  times: number;
  dropCount: number;
  drops: string;
  medicine: number;
  stone: number;
  duration: string;
  sanityDepleted: boolean;
}

function getErrorText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  return [record.message, record.stdout, record.stderr].filter(Boolean).join('\n');
}

/** 判断日志或错误文本是否表示理智不足或无可执行作战。 */
export function isFightSanityDepleted(output: string | null | undefined, stage: string | null | undefined = ''): boolean {
  const text = String(output || '');
  if (!text) return false;

  const lowerOutput = text.toLowerCase();
  const lowerStage = String(stage || '').toLowerCase();
  const sanityPatterns = [
    'sanity is not enough',
    '理智不足',
    '理智已耗尽',
    'not enough sanity',
    'insufficient sanity',
    'no sanity',
    'sanity depleted'
  ];

  if (sanityPatterns.some(pattern => lowerOutput.includes(pattern))) return true;
  if (/fight\s+(?:[a-z0-9-]+\s+)?0\s+times?/i.test(text)) return true;

  if (text.includes('Summary') && text.includes('[Fight]') && text.includes('Completed')) {
    const hasFightRecord = /Fight\s+[A-Z0-9-]+\s+[1-9]\d*\s+times?/i.test(text);
    const isAnnihilation = lowerStage.includes('annihilation') || lowerStage.includes('剿灭');
    if (!hasFightRecord && !isAnnihilation) return true;
  }

  return false;
}

/** 解析一次作战步骤的总结、输出与错误。 */
export function createFightExecutionAction(
  taskName: string,
  requestedStage: string | null | undefined,
  options: FightActionOptions = {}
): FightExecutionAction {
  const summary = options.summary || null;
  const stage = String(summary?.stage || requestedStage || '').trim();
  const times = Math.max(0, Number(summary?.times) || 0);
  const dropCount = Array.isArray(summary?.dropItems) ? summary.dropItems.length : 0;
  const output = String(options.output || '');
  const errorText = getErrorText(options.error);
  const combinedOutput = [output, errorText].filter(Boolean).join('\n');
  const sanityDepleted = isFightSanityDepleted(combinedOutput, stage);
  const baseAction: Omit<FightExecutionAction, 'status' | 'message'> = {
    task: taskName,
    action: 'fight',
    stage,
    times,
    dropCount,
    drops: typeof summary?.drops === 'string' ? summary.drops : '',
    medicine: Math.max(0, Number(summary?.medicine) || 0),
    stone: Math.max(0, Number(summary?.stone) || 0),
    duration: typeof summary?.duration === 'string' ? summary.duration : '',
    sanityDepleted
  };

  if (options.skipReason) {
    return {
      ...baseAction,
      status: 'skipped',
      message: `${stage || '当前关卡'}已跳过：${options.skipReason}`
    };
  }

  if (errorText) {
    if (sanityDepleted) {
      return {
        ...baseAction,
        status: 'skipped',
        message: `${stage || '当前关卡'}未继续作战：理智已耗尽`
      };
    }

    if (/stage not open|关卡未开放/i.test(errorText)) {
      return {
        ...baseAction,
        status: 'skipped',
        message: `${stage || '当前关卡'}已跳过：关卡未开放或不存在`
      };
    }

    if (/annihilation|剿灭/i.test(stage)) {
      return {
        ...baseAction,
        status: 'skipped',
        message: `${stage || '剿灭关卡'}已跳过：奖励可能已领完或未找到入口`
      };
    }

    return {
      ...baseAction,
      status: 'failed',
      message: `${stage || '当前关卡'}作战失败：${errorText.split('\n')[0]}`
    };
  }

  if (times === 0 && sanityDepleted) {
    return {
      ...baseAction,
      status: 'skipped',
      message: `${stage || '当前关卡'}未开始作战：理智已耗尽`
    };
  }

  if (times === 0 && /annihilation|剿灭/i.test(stage)) {
    return {
      ...baseAction,
      status: 'skipped',
      message: `${stage || '剿灭关卡'}未执行作战，奖励可能已领完`
    };
  }

  const details: string[] = [];
  if (times > 0) details.push(`${stage || '当前关卡'} × ${times}`);
  else if (stage) details.push(stage);
  if (dropCount > 0) details.push(`获得 ${dropCount} 种掉落`);
  if (sanityDepleted) details.push('理智已耗尽');

  return {
    ...baseAction,
    status: 'success',
    message: details.length > 0 ? `作战完成：${details.join('；')}` : '理智作战已完成'
  };
}
