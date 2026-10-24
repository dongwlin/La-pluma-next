// Keep task identity separate from action names (one task can produce several actions).
export function createScheduleTaskProgress(tasks, getCounts, publish) {
  let results = tasks.map(task => ({ taskId: task.id, task: task.name, status: 'pending' }));
  let active = null;

  const update = (taskId, status) => {
    results = results.map(result => result.taskId === taskId ? { ...result, status } : result);
    publish(results);
  };

  const finish = ({ stopped = false } = {}) => {
    if (!active) return;
    const counts = getCounts();
    const status = counts.failedCount > active.counts.failedCount ? (stopped ? 'stopped' : 'failed')
      : counts.successCount > active.counts.successCount ? 'success'
        : counts.skippedCount > active.counts.skippedCount ? 'skipped'
          : stopped ? 'stopped' : 'failed';
    update(active.taskId, status);
    active = null;
  };

  publish(results);
  return {
    start(taskId) {
      active = { taskId, counts: { ...getCounts() } };
      update(taskId, 'running');
    },
    finish,
    get results() { return results; },
  };
}
