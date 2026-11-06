import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEnabledAwardItems, parseAwardExecutionActions } from '../awardResultService.ts';

const callback = (type: string, payload: Record<string, unknown>): string =>
  `[2026-07-10 20:20:00.000][INF] Assistant::append_callback | ${type} ${JSON.stringify({
    taskchain: 'Award',
    ...payload
  })}`;

describe('award execution results', () => {
  it('maps every supported MaaCore award switch to an award item', () => {
    const switches = ['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess', 'signinevent'];
    const params = Object.fromEntries(switches.map(key => [key, true]));

    assert.deepEqual(getEnabledAwardItems(params).map(item => item.key), switches);
  });

  it('only confirms an item after its claim task completes', () => {
    const log = [
      callback('SubTaskStart', { first: ['AwardBegin'], details: { task: 'ReceiveAward' } }),
      callback('SubTaskCompleted', { first: ['AwardBegin'], details: { task: 'ReceiveAward' } }),
      callback('SubTaskStart', { first: ['MailBegin'], details: { task: 'ReceiveMail' } }),
      callback('TaskChainCompleted', { details: {} })
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', {
      award: true,
      mail: true
    }, log);

    assert.deepEqual(actions.map(action => action.status), ['success', 'skipped']);
    assert.equal(actions[0].observed, true);
    assert.equal(actions[1].observed, true);
    assert.match(actions[0].message, /已领取/);
    assert.match(actions[1].message, /未观察到完成回调/);
  });

  it('confirms the limited-time sign-in event after its claim completes', () => {
    const log = [
      callback('SubTaskStart', { first: ['SignInEventBegin'], details: { task: 'SignInEventClaim' } }),
      callback('SubTaskCompleted', { first: ['SignInEventBegin'], details: { task: 'SignInEventEarnRewards' } })
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', { signinevent: true }, log);

    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'success');
    assert.equal(actions[0].observed, true);
    assert.match(actions[0].message, /限时签到活动奖励已领取/);
  });

  it('treats an unavailable or empty log as unconfirmed instead of success', () => {
    for (const log of [null, undefined, '']) {
      const actions = parseAwardExecutionActions('领取奖励', { award: true, mail: true }, log);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].status, 'failed');
      assert.equal(actions[0].observed, false);
      assert.match(actions[0].message, /未确认/);
    }
  });

  it('keeps the legacy completion fallback for a readable log without structured callbacks', () => {
    const actions = parseAwardExecutionActions('领取奖励', { award: true, mail: true }, '[INF] Award flow finished\n');

    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'success');
    assert.equal(actions[0].observed, false);
    assert.match(actions[0].message, /共检查 2 项/);
    assert.match(actions[0].message, /结果未确认/);
  });

  it('reports an unconfirmed item when its segment is missing', () => {
    const log = [
      callback('SubTaskCompleted', {
        first: ['AwardBegin'],
        details: { task: 'ReceiveAward' }
      })
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', { award: true, mail: true }, log);
    assert.deepEqual(actions.map(action => action.status), ['success', 'failed']);
    assert.match(actions[1].message, /邮件奖励.*未确认/);
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

  it('keeps the completion evidence when a trailing callback line is truncated', () => {
    const log = [
      callback('SubTaskCompleted', { first: ['AwardBegin'], details: { task: 'ReceiveAward' } }),
      '[2026-07-10 20:20:01.000][INF] Assistant::append_callback | SubTaskStart {"taskchain":"Award","first":["AwardBegin"],"details":{"ta'
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', { award: true }, log);

    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'success');
    assert.match(actions[0].message, /已领取/);
  });

  it('names the limited-banner free pull and the anniversary card reward', () => {
    assert.deepEqual(
      getEnabledAwardItems({ recruit: true, specialaccess: true }).map(item => item.label),
      ['限定池免费单抽', '周年赠送月卡']
    );
  });

  it('reports the recruit and specialaccess segments with their own names', () => {
    const log = [
      callback('SubTaskCompleted', {
        first: ['RecruitingActivitiesBegin'],
        details: { task: 'RecruitingActivitiesRecruit' }
      }),
      callback('SubTaskCompleted', {
        first: ['SpecialAccessActivitiesBegin'],
        details: { task: 'SpecialAccessActivitiesConfirm' }
      })
    ].join('\n');

    const actions = parseAwardExecutionActions('领取奖励', {
      recruit: true,
      specialaccess: true
    }, log);

    assert.deepEqual(actions.map(action => action.message), [
      '限定池免费单抽已领取',
      '周年赠送月卡已领取'
    ]);
  });
});
