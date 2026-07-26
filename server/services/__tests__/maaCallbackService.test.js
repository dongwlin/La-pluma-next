import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaaCallbackEvents } from '../maaCallbackService.js';

describe('Maa callback parsing', () => {
  it('parses matching callbacks from structured payloads regardless of JSON spacing', () => {
    const log = [
      '[INF] Assistant::append_callback | SubTaskStart { "taskchain": "Recruit", "details": { "task": "RecruitConfirm" } }',
      '[INF] Assistant::append_callback | TaskChainCompleted {"taskchain":"Recruit","details":{}}'
    ].join('\n');

    assert.deepEqual(parseMaaCallbackEvents(log, 'Recruit'), [
      {
        taskchain: 'Recruit',
        details: { task: 'RecruitConfirm' },
        callback: 'SubTaskStart'
      },
      {
        taskchain: 'Recruit',
        details: {},
        callback: 'TaskChainCompleted'
      }
    ]);
  });

  it('ignores callbacks for other task chains and unrelated log lines', () => {
    const log = [
      '[INF] ordinary log line',
      '[INF] Assistant::append_callback | SubTaskStart {"taskchain":"Mall","details":{}}',
      '[INF] Assistant::append_callback | SubTaskStart {"taskchain":"Recruit","details":{}}'
    ].join('\n');

    const events = parseMaaCallbackEvents(log, 'Recruit');
    assert.equal(events.length, 1);
    assert.equal(events[0].taskchain, 'Recruit');
  });

  it('skips incomplete and malformed callback lines from incremental logs', () => {
    const log = [
      '[INF] Assistant::append_callback | SubTaskStart {"taskchain":"Recruit"',
      '[INF] Assistant::append_callback | SubTaskStart not-json',
      '[INF] Assistant::append_callback | TaskChainCompleted {"taskchain":"Recruit"}'
    ].join('\n');

    assert.deepEqual(parseMaaCallbackEvents(log, 'Recruit'), [{
      taskchain: 'Recruit',
      callback: 'TaskChainCompleted'
    }]);
  });
});
