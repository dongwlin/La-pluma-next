import { getMaaExecutionDiagnostics } from './maaProcessService.js';

// 流程结果聚合：从命令输出与任务日志提炼执行结果，不读取设备、存储或通知配置。
// 纯函数便于脱离设备验证步骤结果与完成消息。

export function getFightReportResults(task, stage, result) {
  const stderr = String(result?.stderr || '');
  const diagnostics = getMaaExecutionDiagnostics(stderr);
  const completedFight = /Fight\s+\S+\s+[1-9]\d*\s+times?/i.test(String(result?.stdout || ''));
  if (!completedFight && diagnostics.length === 0) {
    return { reportResults: [], diagnostics };
  }
  const hasUnknownDrops = diagnostics.some(diagnostic => diagnostic.code === 'UNKNOWN_DROPS');
  const reportResults = [];

  const addReport = (provider, enabled, failurePattern, successMessage, failureMessage) => {
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

/**
 * 解析 MAA 任务总结信息
 */
export function parseTaskSummary(taskName, output, logger = null) {
  const summary = { task: taskName };

  // 调试：打印原始输出
  logger?.debug('解析任务总结', {
    taskName,
    outputLength: output.length
  });
  logger?.debug('任务总结完整输出', { output });

  // 解析 MAA 的实际输出格式
  // 格式示例: Fight OR-7 1 times, drops:

  // 提取关卡和次数
  const fightMatch = output.match(/Fight\s+([A-Z0-9-]+)\s+(\d+)\s+times?/i);
  if (fightMatch) {
    summary.stage = fightMatch[1];
    summary.times = fightMatch[2];
  }

  // 提取掉落信息
  // 格式: total drops: "生香" × 21, 全新装置 × 1, 龙门币 × 252
  const totalDropsMatch = output.match(/total drops:\s*(.+?)(?:\n|$)/i);
  if (totalDropsMatch) {
    const dropsText = totalDropsMatch[1].trim();
    // 解析每个物品
    const itemMatches = dropsText.matchAll(/(?:"([^"]+)"|([^\s,×]+))\s*×\s*(\d+)/g);
    const drops = [];
    const dropItems = []; // 用于记录的结构化数据
    for (const match of itemMatches) {
      const itemName = match[1] || match[2];
      const count = parseInt(match[3]);
      drops.push(`${itemName} × ${count}`);
      dropItems.push({ name: itemName, count });
    }
    if (drops.length > 0) {
      summary.drops = drops.join(', ');
      summary.dropItems = dropItems; // 保存结构化数据
    }
  }

  // 提取理智药和源石使用（如果有的话）
  const medicineMatch = output.match(/medicine[:\s]+(\d+)/i);
  if (medicineMatch) {
    summary.medicine = medicineMatch[1];
  }

  const stoneMatch = output.match(/stone[:\s]+(\d+)/i);
  if (stoneMatch) {
    summary.stone = stoneMatch[1];
  }

  // 提取执行时间
  const timeMatch = output.match(/\[Fight\]\s+([\d:]+)\s+-\s+([\d:]+)\s+\(([^)]+)\)/);
  if (timeMatch) {
    summary.duration = timeMatch[3];
  }

  // 解析公招总结
  if (output.includes('Recruit')) {
    const recruitMatches = output.matchAll(/Recruit[:\s]+\[([^\]]+)\]\s*->\s*(\d+)\*/gi);
    const recruits = [];
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

  // 解析基建总结
  if (output.includes('Infrast')) {
    const infrastMatch = output.match(/Infrast[:\s]+([^\n]+)/i);
    if (infrastMatch) {
      summary.infrast = infrastMatch[1].trim();
    }
  }

  logger?.debug('任务总结解析结果', { summary });

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
}) {
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
