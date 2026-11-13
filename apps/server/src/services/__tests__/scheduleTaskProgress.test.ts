import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduleTaskProgress } from '../scheduleTaskProgress.ts';
import type { ScheduleTaskCounts, ScheduleTaskProgressResult } from '../scheduleTaskProgress.ts';

function fixture() {
  const counts: ScheduleTaskCounts = { successCount: 0, failedCount: 0, skippedCount: 0 };
  const snapshots: ScheduleTaskProgressResult[][] = [];
  const progress = createScheduleTaskProgress(
    ['fight-1', 'fight-2', 'award-1'].map(taskId => ({ id: taskId, name: '同名任务' })),
    () => counts,
    results => snapshots.push(results)
  );
  return { counts, snapshots, progress };
}

test('tracks duplicate names by id and preserves earlier polling snapshots', () => {
  const { counts, snapshots, progress } = fixture();
  progress.start('fight-1');
  counts.successCount++;
  progress.finish();
  progress.start('fight-2');
  counts.failedCount++;
  progress.finish();
  progress.start('award-1');
  counts.skippedCount++;
  progress.finish();
  assert.deepEqual(progress.results.map(result => result.status), ['success', 'failed', 'skipped']);
  assert.deepEqual(snapshots[0].map(result => result.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(snapshots[1].map(result => result.status), ['running', 'pending', 'pending']);
});

test('a stopped task leaves queued tasks unexecuted and keeps completed results', () => {
  const { counts, progress } = fixture();
  progress.start('fight-1');
  counts.successCount++;
  progress.finish();
  progress.start('fight-2');
  progress.finish({ stopped: true });
  assert.deepEqual(progress.results.map(result => result.status), ['success', 'stopped', 'pending']);
});

test('stopping during the delay after completion preserves the successful result', () => {
  const { counts, progress } = fixture();
  progress.start('fight-1');
  counts.successCount++;
  progress.finish({ stopped: true });
  assert.equal(progress.results[0].status, 'success');
});

test('an unexpected error never leaves a task running or marks queued tasks successful', () => {
  const { progress } = fixture();
  progress.start('fight-1');
  progress.finish();
  progress.finish();
  assert.deepEqual(progress.results.map(result => result.status), ['failed', 'pending', 'pending']);
});

test('a skipped result is retained when execution stops before the next task', () => {
  const { counts, progress } = fixture();
  progress.start('fight-1');
  counts.skippedCount++;
  progress.finish({ stopped: true });
  assert.deepEqual(progress.results.map(result => result.status), ['skipped', 'pending', 'pending']);
});
