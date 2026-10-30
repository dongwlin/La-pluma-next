import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';

// `maa dir resource` 的解析在导入时读取 MAA_CLI_PATH；先准备假 CLI，再加载被测模块。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-plan-'));
const fakeMaaCliPath = join(fixtureDir, 'fake-maa-cli.js');
const maaCallLog = join(fixtureDir, 'maa-calls.log');
const baseResourceDir = join(fixtureDir, 'base-resource');
await mkdir(join(baseResourceDir, 'Arknights-Tile-Pos'), { recursive: true });
await writeFile(join(baseResourceDir, 'stages.json'), '[]');
await writeFile(fakeMaaCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_MAA_CALL_LOG) fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, args.join(' ') + '\\n');
if (args[0] === 'dir' && args[1] === 'resource') {
  process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeMaaCliPath;
process.env.FAKE_MAA_CALL_LOG = maaCallLog;
process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;

const {
  buildCopilotPlan,
  buildCurrentMapStageTasks,
  buildCopilotRepeatFiles,
  buildCopilotTaskParams,
  classifyCopilotEntryOutcomes,
  ensurePresetFormationResource,
  extractLoadedCopilotFiles,
  getNavigationStage,
  isPresetFormationCopilot,
  mergePresetFormationTasks,
  resetCopilotPlanCachesForTests
} = await import('../copilotPlanService.ts');

beforeEach(async () => {
  resetCopilotPlanCachesForTests();
  process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
  await writeFile(maaCallLog, '');
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function readMaaCalls(): Promise<string[]> {
  return (await readFile(maaCallLog, 'utf8')).trim().split('\n').filter(Boolean);
}

function readObject(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function readUserTasks(configDir: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(configDir, 'resource', 'tasks', 'tasks.json'), 'utf8'));
  return readObject(parsed);
}

/** 作业站与企鹅物流都走同一 fetch 桩；计划只关心 stage_name 与 apCost。 */
function stubPlanFetch(stageName: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url);
    const data = text.includes('/set/get')
      ? { id: 1, name: 'set', copilot_ids: [10] }
      : text.includes('penguin-stats.io')
        ? []
        : { content: JSON.stringify({ stage_name: stageName, doc: { title: 'T-1' }, opers: [{ name: 'A' }], groups: [] }) };
    return new Response(JSON.stringify({ status_code: 200, data }), { status: 200 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

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
  // 出站端口经 text() 消费响应体；stub 用真实 Response 承载 JSON 文本，零网络访问。
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url);
    const data = text.includes('/set/get')
      ? { id: 1, name: 'set', copilot_ids: [10, 10, 11] }
      : text.endsWith('/10')
        ? { content: JSON.stringify({ stage_name: 'act_test_01', doc: { title: 'T-1' }, opers: [{ name: 'A' }], groups: [] }) }
        : { content: JSON.stringify({ stage_name: 'act_test_s01', doc: { title: 'T-S-1' }, opers: [], groups: [] }) };
    return new Response(JSON.stringify({ status_code: 200, data }), { status: 200 });
  };
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

test('buildCopilotPlan reuses the resource directory and stage catalog', async () => {
  const resourceDir = join(fixtureDir, 'cached-resource');
  const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
  const stagesPath = join(resourceDir, 'stages.json');
  await mkdir(tileDir, { recursive: true });
  await writeFile(stagesPath, JSON.stringify([
    { stageId: 'act_cache_01', code: 'CA-1', apCost: 21 }
  ]));
  const stagesStat = await stat(stagesPath);
  process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
  const restoreFetch = stubPlanFetch('act_cache_01');
  try {
    const first = await buildCopilotPlan('cache-set');
    const second = await buildCopilotPlan('cache-set');
    assert.equal(first.items[0]?.apCost, 21);
    assert.equal(second.items[0]?.apCost, 21);
    assert.equal((await readMaaCalls()).filter(line => line === 'dir resource').length, 1);

    // 内容损坏但 mtime 未变时沿用已解析的目录快照，不重新读取 stages.json。
    await writeFile(stagesPath, 'not-json');
    await utimes(stagesPath, stagesStat.atimeMs / 1000, stagesStat.mtimeMs / 1000);
    const sameVersion = await buildCopilotPlan('cache-set');
    assert.equal(sameVersion.items[0]?.apCost, 21);

    // mtime 前进后重新解析，拿到资源更新后的理智消耗。
    await writeFile(stagesPath, JSON.stringify([
      { stageId: 'act_cache_01', code: 'CA-1', apCost: 42 }
    ]));
    const updatedAt = new Date(Date.now() + 2000);
    await utimes(stagesPath, updatedAt, updatedAt);
    const updated = await buildCopilotPlan('cache-set');
    assert.equal(updated.items[0]?.apCost, 42);
    assert.equal((await readMaaCalls()).filter(line => line === 'dir resource').length, 1);
  } finally {
    restoreFetch();
  }
});

test('ensurePresetFormationResource reuses cached resource reads', async () => {
  const resourceDir = join(fixtureDir, 'preset-resource');
  const tasksPath = join(resourceDir, 'tasks', 'tasks.json');
  const configDir = join(fixtureDir, 'preset-config');
  await mkdir(join(resourceDir, 'tasks'), { recursive: true });
  await writeFile(tasksPath, JSON.stringify({
    BattleStart: { postDelay: 1000 },
    InstalledOnly: { action: 'DoNothing' }
  }));
  const tasksStat = await stat(tasksPath);
  process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;

  await ensurePresetFormationResource(configDir);
  await ensurePresetFormationResource(configDir);
  assert.equal((await readMaaCalls()).filter(line => line === 'dir resource').length, 1);

  const firstUser = await readUserTasks(configDir);
  const firstBattleStart = readObject(firstUser.BattleStart);
  assert.equal(firstBattleStart.postDelay, 1000);
  assert.ok(Array.isArray(firstBattleStart.next) && firstBattleStart.next.includes('LaPlumaPresetBattleConfirm'));

  // 修改内容但保持 mtime：仍应使用缓存中的已安装任务。
  await writeFile(tasksPath, JSON.stringify({ BattleStart: { postDelay: 999 } }));
  await utimes(tasksPath, tasksStat.atimeMs / 1000, tasksStat.mtimeMs / 1000);
  await rm(join(configDir, 'resource'), { recursive: true, force: true });
  await ensurePresetFormationResource(configDir);
  assert.equal(readObject((await readUserTasks(configDir)).BattleStart).postDelay, 1000);

  // mtime 前进后重新读取已安装任务。
  await writeFile(tasksPath, JSON.stringify({ BattleStart: { postDelay: 777 } }));
  const updatedAt = new Date(Date.now() + 2000);
  await utimes(tasksPath, updatedAt, updatedAt);
  await rm(join(configDir, 'resource'), { recursive: true, force: true });
  await ensurePresetFormationResource(configDir);
  assert.equal(readObject((await readUserTasks(configDir)).BattleStart).postDelay, 777);
});
