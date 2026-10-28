import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCopilotPlan,
  buildCurrentMapStageTasks,
  buildCopilotRepeatFiles,
  buildCopilotTaskParams,
  classifyCopilotEntryOutcomes,
  extractLoadedCopilotFiles,
  getNavigationStage,
  isPresetFormationCopilot,
  mergePresetFormationTasks
} from '../copilotPlanService.ts';

test('preset formation stages are normal-only candidates', () => {
  assert.equal(isPresetFormationCopilot({
    stage_name: 'act21mini_s01',
    opers: [],
    groups: []
  }), true);
  assert.equal(isPresetFormationCopilot({
    stage_name: 'act21mini_04',
    opers: [{ name: '德克萨斯' }],
    groups: []
  }), false);
});

test('current map resource maps stages directly to OCR without navigation tasks', () => {
  assert.deepEqual(buildCurrentMapStageTasks(['bd-1', 'BD-2', 'BD-1']), {
    'BD-1': { text: ['BD-1'] },
    'BD-2': { text: ['BD-2'] }
  });
});

test('navigation uses the visible stage code instead of the internal stage id', () => {
  assert.equal(getNavigationStage({ stage_name: 'act21mini_04', doc: { title: 'BD-4 低配挂机' } }), 'BD-4');
  assert.equal(getNavigationStage({ stage_name: 'main_01-07', doc: { title: '1-7' } }), '1-7');
});

test('native copilot plans keep all advanced execution options', () => {
  const params = buildCopilotTaskParams([{ filename: '/tmp/a.json' }], false, {
    formationMode: 'off',
    ignoreRequirements: false,
    useSanityPotion: true,
    addTrust: true,
    formationIndex: '3',
    supportUsage: '2',
    supportName: '逻各斯'
  });
  assert.deepEqual(params, {
    copilot_list: [{ filename: '/tmp/a.json' }],
    formation: false,
    ignore_requirements: false,
    use_sanity_potion: true,
    add_trust: true,
    formation_index: 3,
    support_unit_usage: 2,
    support_unit_name: '逻各斯'
  });
});

test('multi-copilot loop count expands into repeated native entries', () => {
  const files = buildCopilotRepeatFiles({ itemIndex: 2, copilotId: 99, mode: 'raid' }, 3, '/tmp/plan');
  assert.equal(files.length, 3);
  assert.ok(files[0].filename.endsWith('2-99-raid-1.json'));
  assert.ok(files[2].filename.endsWith('2-99-raid-3.json'));
});

test('copilot recovery finds MAA loaded files in callback field order', () => {
  const log = '{"details":{"file_name":"/tmp/6-97353-normal-1.json"},"what":"CopilotListLoadTaskFileSuccess"}';
  assert.deepEqual(extractLoadedCopilotFiles(log), ['/tmp/6-97353-normal-1.json']);
});

test('preset resource merge preserves existing user BattleStart settings', () => {
  const merged = mergePresetFormationTasks(
    { BattleStart: { roi: [1, 2, 3, 4], postDelay: 1000 } },
    { BattleStart: { postDelay: 4321, custom: true }, ExistingTask: { action: 'DoNothing' } }
  );
  assert.equal(merged.BattleStart.postDelay, 4321);
  assert.equal(merged.BattleStart.custom, true);
  assert.deepEqual(merged.ExistingTask, { action: 'DoNothing' });
  const next = merged.BattleStart.next;
  assert.ok(Array.isArray(next) && next.includes('LaPlumaPresetBattleConfirm'));
});

test('both mode skips raid for preset formation stages', async () => {
  const originalFetch = globalThis.fetch;
  // 出站端口经 text() 消费响应体；stub 返回 JSON 文本，零网络访问。
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url);
    const data = text.includes('/set/get')
      ? { id: 1, name: 'set', copilot_ids: [10, 10, 11] }
      : text.endsWith('/10')
        ? { content: JSON.stringify({ stage_name: 'act_test_01', doc: { title: 'T-1' }, opers: [{ name: 'A' }], groups: [] }) }
        : { content: JSON.stringify({ stage_name: 'act_test_s01', doc: { title: 'T-S-1' }, opers: [], groups: [] }) };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ status_code: 200, data }) };
  }) as unknown as typeof fetch;
  try {
    const plan = await buildCopilotPlan('1', 'both');
    assert.deepEqual(plan.entries.map(entry => entry.key), [
      '0:10:normal', '0:10:raid',
      '1:10:normal', '1:10:raid',
      '2:11:normal'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loaded files classify confirmed entries and stop the rest as pending', () => {
  const entries = [
    { key: 'a', itemIndex: 0 },
    { key: 'b', itemIndex: 1 },
    { key: 'c', itemIndex: 2 }
  ];
  const executionItems = [
    { entry: entries[0], filename: '/tmp/0.json' },
    { entry: entries[1], filename: '/tmp/1.json' },
    { entry: entries[2], filename: '/tmp/2.json' }
  ];

  assert.deepEqual(
    classifyCopilotEntryOutcomes({
      entries,
      executionItems,
      currentIndex: 2,
      stopped: true,
      message: '已停止'
    }).map(item => [item.entry.key, item.status]),
    [['a', 'success'], ['b', 'success'], ['c', 'stopped']]
  );

  assert.deepEqual(
    classifyCopilotEntryOutcomes({
      entries,
      executionItems,
      currentIndex: 1,
      stopped: false,
      message: '失败'
    }).map(item => [item.entry.key, item.status]),
    [['a', 'success'], ['b', 'failed'], ['c', 'failed']]
  );

  assert.deepEqual(
    classifyCopilotEntryOutcomes({
      entries,
      executionItems,
      currentIndex: -1,
      stopped: true,
      message: '已停止'
    }).map(item => [item.entry.key, item.status]),
    [['a', 'pending'], ['b', 'pending'], ['c', 'pending']]
  );
});
