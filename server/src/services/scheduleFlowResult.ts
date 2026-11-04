import { getMaaExecutionDiagnostics } from './maaProcessService.ts';
import type { MaaExecutionDiagnostic } from './maaProcessService.ts';
import type { AwardExecutionAction } from './awardResultService.ts';
import type { RecruitExecutionAction } from './recruitResultService.ts';
import type { InfrastExecutionAction } from './infrastResultService.ts';
import type { MallExecutionAction } from './mallResultService.ts';
import type { FightExecutionAction } from './fightResultService.ts';
import type { DropItem } from './dropRecordService.ts';
import type { ScheduleTaskProgressResult } from './scheduleTaskProgress.ts';

// 流程结果聚合：从命令输出与任务日志提炼执行结果，不读取设备、存储或通知配置。
// 外部文本解析结果逐字段可选、缺失不补占位值；步骤结果用有穷联合区分跳过/失败/成功，
// 取消由流程进度的 `stopped` 表达；完成消息优先级：停止 > 掉落汇报失败 > 任务失败 > 正常完成。

export interface FlowTaskSummary {
  task: string;
  [extension: string]: unknown;
  stage?: string;
  times?: string;
  drops?: string;
  dropItems?: DropItem[];
  medicine?: string;
  stone?: string;
  duration?: string;
  recruits?: Array<{ tags: string; stars: string }>;
  infrast?: string;
}

export interface FightReportResult {
  provider: 'penguin' | 'yituliu';
  stage: string;
  status: 'success' | 'failed';
  message: string;
}

/** 掉落汇报只看任务参数中的两个开关；其余字段由任务自己维护。 */
export interface FightReportTaskLike {
  params?: {
    report_to_penguin?: unknown;
    report_to_yituliu?: unknown;
    [extension: string]: unknown;
  };
}

export interface FightReportOutputLike {
  stdout?: unknown;
  stderr?: unknown;
}

/** `parseTaskSummary` 只使用 debug 级别；测试可传空实现。 */
export interface FlowSummaryLogger {
  debug?(message: string, data?: unknown): unknown;
}

export interface ScheduleBuiltinStepAction {
  task: string;
  action: 'startup' | 'closedown' | 'depot';
  status: 'success' | 'failed';
  message: string;
}

/** 流程层记录的失败收尾：结果服务要求完整观测字段，失败只保留任务与消息。 */
export interface ScheduleFailureStepAction {
  task: string;
  action: 'award' | 'recruit' | 'infrast' | 'mall';
  status: 'failed';
  message: string;
}

/**
 * 步骤结果联合：领取、公招、基建、信用收支、作战来自各自的 `*ResultService`，
 * 启动/关闭/仓库识别由流程直接构造；`status` 不会同时表示两种结论。
 */
export type ScheduleStepAction =
  | AwardExecutionAction
  | RecruitExecutionAction
  | InfrastExecutionAction
  | MallExecutionAction
  | FightExecutionAction
  | ScheduleBuiltinStepAction
  | ScheduleFailureStepAction;

export interface FlowTaskError {
  task: string;
  error: string;
}

export interface FlowTaskSkip {
  task: string;
  reason: string;
}

export interface FlowExecutionSummary {
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  summaries: FlowTaskSummary[];
  reports: FightReportResult[];
  actions: ScheduleStepAction[];
  errors: FlowTaskError[];
  warnings: string[];
  taskResults: ScheduleTaskProgressResult[];
}

export interface FlowExecutionOutcomeInput {
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  wasStopped: boolean;
  summaries: FlowTaskSummary[];
  reports: FightReportResult[];
  actions: ScheduleStepAction[];
  errors: FlowTaskError[];
  warnings: string[];
  taskResults: ScheduleTaskProgressResult[];
}

export interface FlowExecutionOutcome {
  completionMessage: string;
  executionSummary: FlowExecutionSummary;
}

export interface FightReportSummary {
  reportResults: FightReportResult[];
  diagnostics: MaaExecutionDiagnostic[];
}

export function getFightReportResults(
  task: FightReportTaskLike,
  stage: string,
  result: FightReportOutputLike | null | undefined
): FightReportSummary {
  const stderr = String(result?.stderr || '');
  const diagnostics = getMaaExecutionDiagnostics(stderr);
  const completedFight = /Fight\s+\S+\s+[1-9]\d*\s+times?/i.test(String(result?.stdout || ''));
  if (!completedFight && diagnostics.length === 0) {
    return { reportResults: [], diagnostics };
  }
  const hasUnknownDrops = diagnostics.some(diagnostic => diagnostic.code === 'UNKNOWN_DROPS');
  const reportResults: FightReportResult[] = [];

  const addReport = (
    provider: FightReportResult['provider'],
    enabled: unknown,
    failurePattern: RegExp,
    successMessage: string,
    failureMessage: string
  ) => {
    if (!enabled) return;
    const failed = hasUnknownDrops || failurePattern.test(stderr);
    reportResults.push({
      provider,
      stage,
      status: failed ? 'failed' : 'success',
      message: failed
        ? (hasUnknownDrops ? '存在未识别掉落，未发送汇报' : failureMessage)
        : successMessage
    });
  };

  addReport(
    'penguin',
    task.params?.report_to_penguin,
    /FailedToReportToPenguinStats/i,
    '已汇报至企鹅物流',
    '企鹅物流汇报失败'
  );
  addReport(
    'yituliu',
    task.params?.report_to_yituliu,
    /FailedToReportToYituliu/i,
    '已汇报至一图流',
    '一图流汇报失败'
  );

  return { reportResults, diagnostics };
}

export function parseTaskSummary(
  taskName: string,
  output: string,
  logger: FlowSummaryLogger | null = null
): FlowTaskSummary | null {
  const summary: FlowTaskSummary = { task: taskName };

  logger?.debug?.('解析任务总结', {
    taskName,
    outputLength: output.length
  });
  logger?.debug?.('任务总结完整输出', { output });

  const fightMatch = output.match(/Fight\s+([A-Z0-9-]+)\s+(\d+)\s+times?/i);
  if (fightMatch) {
    summary.stage = fightMatch[1];
    summary.times = fightMatch[2];
  }

  const totalDropsMatch = output.match(/total drops:\s*(.+?)(?:\n|$)/i);
  if (totalDropsMatch) {
    const dropsText = totalDropsMatch[1].trim();
    const itemMatches = dropsText.matchAll(/(?:"([^"]+)"|([^\s,×]+))\s*×\s*(\d+)/g);
    const drops: string[] = [];
    const dropItems: DropItem[] = [];
    for (const match of itemMatches) {
      const itemName = match[1] || match[2];
      const count = parseInt(match[3]);
      drops.push(`${itemName} × ${count}`);
      dropItems.push({ name: itemName, count });
    }
    if (drops.length > 0) {
      summary.drops = drops.join(', ');
      summary.dropItems = dropItems;
    }
  }

  const medicineMatch = output.match(/medicine[:\s]+(\d+)/i);
  if (medicineMatch) {
    summary.medicine = medicineMatch[1];
  }

  const stoneMatch = output.match(/stone[:\s]+(\d+)/i);
  if (stoneMatch) {
    summary.stone = stoneMatch[1];
  }

  const timeMatch = output.match(/\[Fight\]\s+([\d:]+)\s+-\s+([\d:]+)\s+\(([^)]+)\)/);
  if (timeMatch) {
    summary.duration = timeMatch[3];
  }

  if (output.includes('Recruit')) {
    const recruitMatches = output.matchAll(/Recruit[:\s]+\[([^\]]+)\]\s*->\s*(\d+)\*/gi);
    const recruits: Array<{ tags: string; stars: string }> = [];
    for (const match of recruitMatches) {
      recruits.push({
        tags: match[1],
        stars: match[2]
      });
    }
    if (recruits.length > 0) {
      summary.recruits = recruits;
    }
  }

  if (output.includes('Infrast')) {
    const infrastMatch = output.match(/Infrast[:\s]+([^\n]+)/i);
    if (infrastMatch) {
      summary.infrast = infrastMatch[1].trim();
    }
  }

  logger?.debug?.('任务总结解析结果', { summary });

  return Object.keys(summary).length > 1 ? summary : null;
}

/**
 * 汇总一次流程执行的计数、明细与完成消息。停止优先于失败计数，
 * 掉落汇报失败优先于普通任务失败，保持既有通知文案。
 */
export function buildFlowExecutionOutcome({
  successCount,
  failedCount,
  skippedCount,
  durationMs,
  wasStopped,
  summaries,
  reports,
  actions,
  errors,
  warnings,
  taskResults
}: FlowExecutionOutcomeInput): FlowExecutionOutcome {
  const reportFailureCount = reports.filter(report => report.status === 'failed').length;
  const completionMessage = wasStopped
    ? '任务流程已被用户终止'
    : reportFailureCount > 0
      ? `任务流程执行完成，${reportFailureCount} 项掉落汇报失败`
      : failedCount > 0
        ? `任务流程执行完成，${failedCount} 项任务失败`
        : '任务流程执行完成';

  return {
    completionMessage,
    executionSummary: {
      successCount,
      failedCount,
      skippedCount,
      durationMs,
      summaries,
      reports,
      actions,
      errors,
      warnings,
      taskResults
    }
  };
}
