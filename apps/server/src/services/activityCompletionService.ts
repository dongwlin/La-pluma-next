import { createCopilotProgressStore } from './copilotProgressStore.ts';
import { join } from 'path';
import { fileURLToPath } from 'url';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
// 活动完成进度是共享 JSON 状态：读取经进度存储按路径排队执行；
// 默认位置保持 apps/server/data/activity-copilot-progress.json，可用环境变量注入隔离。
const activityProgressStore = createCopilotProgressStore({
  progressPath: process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE
    || join(dataDir, 'activity-copilot-progress.json')
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ActivityCompletionSummary {
  known: boolean;
  complete: boolean;
  completedStages: string[];
  totalStages: number;
  source: 'local-activity-progress';
}

function readCompletedStages(value: unknown): string[] {
  const entry = isRecord(value) ? value : {};
  return Array.isArray(entry.stages)
    ? entry.stages.filter((stage): stage is string => typeof stage === 'string')
    : [];
}

function readActivityProgressEntry(progress: unknown, code: string): { stages: string[] } | null {
  if (!isRecord(progress) || !isRecord(progress[code])) return null;
  return { stages: readCompletedStages(progress[code]) };
}

export function summarizeActivityCompletion(
  activity: unknown = {},
  progress: unknown = {}
): ActivityCompletionSummary {
  const info = isRecord(activity) ? activity : {};
  const stages = [...new Set((Array.isArray(info.stages) ? info.stages : [])
    .map(stage => String(stage || '').toUpperCase())
    .filter(Boolean))];
  const code = typeof info.code === 'string' ? info.code : '';
  if (!code || !stages.length) {
    return {
      known: false,
      complete: false,
      completedStages: [],
      totalStages: stages.length,
      source: 'local-activity-progress'
    };
  }
  const completedStages = readActivityProgressEntry(progress, code.toUpperCase())?.stages || [];
  return {
    known: true,
    complete: stages.every(stage => completedStages.includes(stage)),
    completedStages: stages.filter(stage => completedStages.includes(stage)),
    totalStages: stages.length,
    source: 'local-activity-progress'
  };
}

export async function getActivityCompletion(activity: unknown = {}): Promise<ActivityCompletionSummary> {
  return summarizeActivityCompletion(activity, await activityProgressStore.load());
}
