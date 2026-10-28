// 任务进度：把每个任务的步骤结论投影为轮询快照。
//
// 类型边界：任务身份用 `taskId`，同名任务不会互相覆盖；状态是有穷联合，
// 跳过/失败/成功/取消（`stopped`）分别建模，未开始的任务保持 `pending`。

/** 单个任务的步骤状态；`stopped` 表示执行在完成前被终止，不是失败。 */
export type ScheduleTaskProgressStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped';

/** 轮询快照中的任务条目：`taskId` 唯一，`task` 是展示名（可能缺失）。 */
export interface ScheduleTaskProgressResult {
  taskId: string;
  task: string | undefined;
  status: ScheduleTaskProgressStatus;
}

/** 完成判定只读取三个计数；停止优先于失败。 */
export interface ScheduleTaskCounts {
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface ScheduleTaskProgressTask {
  id: string;
  name?: string;
}

export interface ScheduleTaskProgressFinishOptions {
  stopped?: boolean;
}

export interface ScheduleTaskProgress {
  start(taskId: string): void;
  finish(options?: ScheduleTaskProgressFinishOptions): void;
  readonly results: ScheduleTaskProgressResult[];
}

// Keep task identity separate from action names (one task can produce several actions).
export function createScheduleTaskProgress(
  tasks: readonly ScheduleTaskProgressTask[],
  getCounts: () => ScheduleTaskCounts,
  publish: (results: ScheduleTaskProgressResult[]) => void
): ScheduleTaskProgress {
  let results: ScheduleTaskProgressResult[] = tasks.map(task => ({
    taskId: task.id,
    task: task.name,
    status: 'pending'
  }));
  let active: { taskId: string; counts: ScheduleTaskCounts } | null = null;

  const update = (taskId: string, status: ScheduleTaskProgressStatus) => {
    results = results.map(result => result.taskId === taskId ? { ...result, status } : result);
    publish(results);
  };

  const finish = ({ stopped = false }: ScheduleTaskProgressFinishOptions = {}) => {
    if (!active) return;
    const counts = getCounts();
    const status: ScheduleTaskProgressStatus = counts.failedCount > active.counts.failedCount
      ? (stopped ? 'stopped' : 'failed')
      : counts.successCount > active.counts.successCount ? 'success'
        : counts.skippedCount > active.counts.skippedCount ? 'skipped'
          : stopped ? 'stopped' : 'failed';
    update(active.taskId, status);
    active = null;
  };

  publish(results);
  return {
    start(taskId: string) {
      active = { taskId, counts: { ...getCounts() } };
      update(taskId, 'running');
    },
    finish,
    get results() { return results; },
  };
}
