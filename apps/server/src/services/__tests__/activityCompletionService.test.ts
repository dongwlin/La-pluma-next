import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeActivityCompletion } from '../activityCompletionService.ts';

test('activity completion requires every known main stage', () => {
  const activity = { code: 'BD', stages: ['BD-1', 'BD-2', 'BD-3'] };
  assert.deepEqual(
    summarizeActivityCompletion(activity, { BD: { stages: ['BD-1', 'BD-2'] } }),
    {
      known: true,
      complete: false,
      completedStages: ['BD-1', 'BD-2'],
      totalStages: 3,
      source: 'local-activity-progress'
    }
  );
  assert.equal(
    summarizeActivityCompletion(activity, { BD: { stages: ['BD-1', 'BD-2', 'BD-3'] } }).complete,
    true
  );
});
