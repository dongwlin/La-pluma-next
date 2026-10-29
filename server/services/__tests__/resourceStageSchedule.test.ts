import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getTodayOpenStages, isStageOpenToday } from '../notificationService.ts';

function stageNames(stages: Array<{ stage: string }>): string[] {
  return stages.map(item => item.stage).sort();
}

describe('resource stage schedule', () => {
  it('reports the Tuesday game day and its open/closed resource stages', () => {
    const overview = getTodayOpenStages({
      now: new Date('2026-10-27T12:00:00+08:00'),
      clientType: 'Official'
    });

    assert.equal(overview.gameDate, '2026-10-27');
    assert.equal(overview.weekday, 2);
    assert.equal(overview.clientType, 'Official');
    assert.deepEqual(stageNames(overview.open), ['CA-5', 'CE-6', 'LS-6', 'PR-B', 'PR-D']);
    assert.deepEqual(stageNames(overview.closed), ['AP-5', 'PR-A', 'PR-C', 'SK-5']);
  });

  it('reports the Wednesday game day after the 04:00 boundary', () => {
    const overview = getTodayOpenStages({
      now: new Date('2026-10-28T04:00:00+08:00'),
      clientType: 'Official'
    });

    assert.equal(overview.gameDate, '2026-10-28');
    assert.equal(overview.weekday, 3);
    assert.deepEqual(stageNames(overview.open), ['CA-5', 'LS-6', 'PR-C', 'PR-D', 'SK-5']);
    assert.deepEqual(stageNames(overview.closed), ['AP-5', 'CE-6', 'PR-A', 'PR-B']);
  });

  it('keeps hidden stage variants out of the overview', () => {
    const overview = getTodayOpenStages({
      now: new Date('2026-10-28T12:00:00+08:00'),
      clientType: 'Official'
    });
    const listed = [...stageNames(overview.open), ...stageNames(overview.closed)];

    for (const hidden of ['PR-A-1', 'PR-A-2', 'PR-B-1', 'PR-B-2', 'PR-C-1', 'PR-C-2', 'PR-D-1', 'PR-D-2']) {
      assert.equal(listed.includes(hidden), false, `${hidden} must stay hidden`);
    }
  });

  it('flips CE-6 exactly at the 04:00 game day boundary', () => {
    const before = isStageOpenToday('CE-6', {
      now: new Date('2026-10-28T03:59:00+08:00'),
      clientType: 'Official'
    });
    const after = isStageOpenToday('CE-6', {
      now: new Date('2026-10-28T04:00:00+08:00'),
      clientType: 'Official'
    });

    assert.deepEqual(before, { isOpen: true, reason: null, stageName: '龙门币' });
    assert.deepEqual(after, { isOpen: false, reason: '龙门币今日未开放', stageName: '龙门币' });
  });

  it('keeps non-resource stages always open', () => {
    assert.deepEqual(
      isStageOpenToday('1-7', { now: new Date('2026-10-28T04:00:00+08:00'), clientType: 'YoStarEN' }),
      { isOpen: true, reason: null }
    );
  });

  it('judges the same instant on different client game days', () => {
    const instant = new Date('2026-10-28T10:00:00Z');

    const official = getTodayOpenStages({ now: instant, clientType: 'Official' });
    assert.equal(official.weekday, 3);
    assert.equal(official.gameDate, '2026-10-28');
    assert.equal(isStageOpenToday('CE-6', { now: instant, clientType: 'Official' }).isOpen, false);

    const english = getTodayOpenStages({ now: instant, clientType: 'YoStarEN' });
    assert.equal(english.weekday, 2);
    assert.equal(english.gameDate, '2026-10-27');
    assert.equal(english.clientType, 'YoStarEN');
    assert.equal(isStageOpenToday('CE-6', { now: instant, clientType: 'YoStarEN' }).isOpen, true);
  });

  it('normalizes the reported client type', () => {
    const overview = getTodayOpenStages({
      now: new Date('2026-10-28T12:00:00+08:00'),
      clientType: 'Txwy'
    });

    assert.equal(overview.clientType, 'txwy');
    assert.equal(overview.weekday, 3);
  });
});
