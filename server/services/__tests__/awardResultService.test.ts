import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEnabledAwardItems, parseAwardExecutionActions } from '../awardResultService.ts';

describe('award execution results', () => {
  it('distinguishes claimed and unavailable Award items from MaaCore events', () => {
    const log = [
      'run subtask 1 / 6 {"first":["AwardBegin"],"taskchain":"Award"}',
      'SubTaskStart {"details":{"task":"ReceiveAward"},"first":["AwardBegin"]}',
      'run subtask 2 / 6 {"first":["MailBegin"],"taskchain":"Award"}',
      'SubTaskStart {"details":{"task":"MailWithoutAward"},"first":["MailBegin"]}',
      'run subtask 3 / 6 {"first":["RecruitingActivitiesBegin"],"taskchain":"Award"}'
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', {
      award: true,
      mail: true
    }, log);

    assert.deepEqual(actions.map(action => action.status), ['success', 'skipped']);
    assert.match(actions[0].message, /已领取/);
    assert.match(actions[1].message, /已跳过/);
  });

  it('falls back to a completed check when incremental MaaCore logs are unavailable', () => {
    const actions = parseAwardExecutionActions('领取奖励', { award: true, mail: true }, '');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'success');
    assert.match(actions[0].message, /共检查 2 项/);
    assert.deepEqual(Object.keys(actions[0]).sort(), ['action', 'message', 'status', 'task']);
  });

  it('skips execution when no Award item is enabled', () => {
    const actions = parseAwardExecutionActions('领取奖励', {}, '');
    assert.equal(actions[0].status, 'skipped');
  });

  it('only enables items whose switch is strictly true', () => {
    const actions = parseAwardExecutionActions('领取奖励', { award: 1, mail: 'true' }, '');

    assert.equal(getEnabledAwardItems({ award: 1, mail: 'true' }).length, 0);
    assert.equal(actions[0].status, 'skipped');
    assert.match(actions[0].message, /未启用任何领取项目/);
  });

  it('keeps the segment conclusion when a trailing callback line is truncated', () => {
    const log = [
      'run subtask 1 / 6 {"first":["AwardBegin"],"taskchain":"Award"}',
      'SubTaskStart {"details":{"task":"ReceiveAward"},"first":["AwardBegin"]'
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', { award: true }, log);

    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'success');
    assert.match(actions[0].message, /已领取/);
  });
});
