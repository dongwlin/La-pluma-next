import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfrastExecutionAction } from '../infrastResultService.ts';

const callback = (type: string, payload: Record<string, unknown>): string =>
  `[2026-07-10 20:00:00.000][INF] Assistant::append_callback | ${type} ${JSON.stringify({
    taskchain: 'Infrast',
    ...payload
  })}`;

describe('infrast execution results', () => {
  it('summarizes only operations observed in MaaCore callbacks', () => {
    const log = [
      callback('SubTaskStart', { class: 'asst::InfrastMfgTask', details: {} }),
      callback('SubTaskStart', { details: { task: 'InfrastReward' } }),
      callback('SubTaskStart', { details: { task: 'InfrastConfirmButton' } }),
      callback('SubTaskStart', { details: { task: 'DroneConfirm' } }),
      callback('TaskChainCompleted', { details: {} })
    ].join('\n');

    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg', 'Trade'] }, log);
    assert.equal(action.status, 'success');
    assert.deepEqual(action.observedFacilities, ['Mfg']);
    assert.equal(action.rewardCollected, true);
    assert.equal(action.rotationApplied, true);
    assert.equal(action.droneUsed, true);
    assert.match(action.message, /已收取产物/);
  });


  it('maps the recycle station and assistant-change facilities', () => {
    const log = [
      callback('SubTaskStart', { class: 'asst::InfrastRecycleTask', details: {} }),
      callback('SubTaskStart', { class: 'asst::InfrastAssistantChangeTask', details: {} }),
      callback('TaskChainCompleted', { details: {} })
    ].join('\n');

    const action = parseInfrastExecutionAction('基建换班', {
      facility: ['Recycle', 'AssistantChange']
    }, log);

    assert.deepEqual(action.observedFacilities, ['Recycle', 'AssistantChange']);
    assert.match(action.message, /回收站/);
    assert.match(action.message, /副手换人/);
  });

  it('does not invent facility details when only completion is observable', () => {
    const log = callback('TaskChainCompleted', { details: {} });
    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg', 'Trade'] }, log);
    assert.equal(action.status, 'success');
    assert.deepEqual(action.observedFacilities, []);
    assert.match(action.message, /按配置处理 2 类设施/);
  });

  it('reports entry recognition failures explicitly', () => {
    const log = [
      callback('SubTaskStart', { details: { task: 'InfrastBegin' } }),
      callback('SubTaskError', { details: {} }),
      callback('TaskChainError', { details: {} })
    ].join('\n');

    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg'] }, log);
    assert.equal(action.status, 'failed');
    assert.match(action.message, /未能进入或识别/);
  });

  it('skips an empty facility selection', () => {
    const action = parseInfrastExecutionAction('基建换班', { facility: [] }, '');
    assert.equal(action.status, 'skipped');
  });

  it('treats a missing or non-array facility selection as empty', () => {
    const missing = parseInfrastExecutionAction('基建换班', {}, '');
    const mistyped = parseInfrastExecutionAction('基建换班', { facility: 'Mfg' }, '');

    assert.equal(missing.status, 'skipped');
    assert.equal(mistyped.status, 'skipped');
    assert.deepEqual(missing.configuredFacilities, []);
    assert.deepEqual(mistyped.configuredFacilities, []);
  });

  it('keeps configured facility names as strings and ignores empty entries', () => {
    const log = callback('TaskChainCompleted', { details: {} });
    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg', 'Mfg', '', 3] }, log);

    assert.deepEqual(action.configuredFacilities, ['Mfg', '3']);
  });

  it('falls back to the completion statement for legacy logs without callbacks', () => {
    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg'] }, '[INF] Infrast done\n');

    assert.equal(action.status, 'success');
    assert.match(action.message, /按配置处理 1 类设施/);
    assert.equal(action.rewardCollected, undefined);
  });

  it('ignores truncated callback lines and other task chains', () => {
    const log = [
      callback('SubTaskStart', { taskchain: 'Mall', details: { task: 'InfrastReward' } }),
      '[2026-07-10 20:00:01.000][INF] Assistant::append_callback | SubTaskStart {"taskchain":"Infrast","details":{"ta',
      callback('SubTaskStart', { details: { task: 'DroneConfirm' } })
    ].join('\n');

    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg'] }, log);
    assert.equal(action.status, 'success');
    assert.equal(action.rewardCollected, false);
    assert.equal(action.droneUsed, true);
  });

  it('preserves skip reasons and candidate lists from custom-infrast callbacks', () => {
    const log = [
      callback('SubTaskExtraInfo', {
        what: 'CustomInfrastRoomOperators',
        class: 'asst::InfrastMfgTask',
        details: { names: ['能天使'], candidates: ['德克萨斯'] }
      }),
      callback('SubTaskExtraInfo', {
        what: 'CustomInfrastRoomKeptUnchanged',
        class: 'asst::InfrastMfgTask',
        details: { reason: 'room_no_intent' }
      }),
      callback('SubTaskExtraInfo', {
        what: 'CustomInfrastRoomGroupsMatchFailed',
        class: 'asst::InfrastTradeTask',
        details: { reason: 'all_unavailable', groups: ['贸易组'] }
      }),
      callback('SubTaskExtraInfo', {
        what: 'CustomInfrastTraineeNotFound',
        class: 'asst::InfrastTrainingTask',
        details: { candidates: ['陈'] }
      }),
      callback('TaskChainCompleted', { details: {} })
    ].join('\n');

    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg', 'Trade'] }, log);

    assert.deepEqual(action.skippedRooms, [
      { facility: 'Mfg', reason: 'room_no_intent' },
      { facility: 'Trade', reason: 'all_unavailable', groups: ['贸易组'] },
      { facility: 'Training', reason: 'CustomInfrastTraineeNotFound', candidates: ['陈'] }
    ]);
    assert.deepEqual(action.roomCandidates, [{
      facility: 'Mfg',
      names: ['能天使'],
      candidates: ['德克萨斯']
    }]);
    assert.match(action.message, /跳过原因/);
    assert.match(action.message, /候选干员 2 位/);
  });

  it('reports an unavailable log as an unconfirmed failure', () => {
    const action = parseInfrastExecutionAction('基建换班', { facility: ['Mfg'] }, null);
    assert.equal(action.status, 'failed');
    assert.match(action.message, /结果未确认/);
  });
});
