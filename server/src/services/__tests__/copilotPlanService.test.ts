import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import type { CopilotPlanEntry } from '../copilotPlanService.ts';

// `maa dir resource` 的解析在导入时读取 MAA_CLI_PATH；先准备假 CLI，再加载被测模块。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-plan-'));
const fakeMaaCliPath = join(fixtureDir, 'fake-maa-cli.js');
const maaCallLog = join(fixtureDir, 'maa-calls.log');
const baseResourceDir = join(fixtureDir, 'base-resource');
const maaConfigDir = join(fixtureDir, 'maa-config');
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaAsstLog = join(maaLogDir, 'asst.log');
await mkdir(join(baseResourceDir, 'Arknights-Tile-Pos'), { recursive: true });
await mkdir(maaConfigDir, { recursive: true });
await mkdir(maaLogDir, { recursive: true });
await mkdir(join(fixtureDir, 'maa-cache'), { recursive: true });
await mkdir(join(fixtureDir, 'drop-records'), { recursive: true });
await writeFile(join(baseResourceDir, 'stages.json'), '[]');
await writeFile(maaAsstLog, '');
await writeFile(fakeMaaCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_MAA_CALL_LOG) fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, args.join(' ') + '\\n');
if (args[0] === 'dir' && args[1] === 'resource') {
  process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'log') {
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else if (args[0] === 'run') {
  const steps = JSON.parse(process.env.FAKE_RUN_STEPS || '[]');
  const exitCode = Number(process.env.FAKE_RUN_EXIT_CODE || 0);
  const exitDelay = Number(process.env.FAKE_RUN_EXIT_DELAY || 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const appendLoad = (file) => fs.appendFileSync(process.env.FAKE_MAA_LOG_FILE || '', 'Assistant::append_callback | SubTaskExtraInfo | ' + JSON.stringify({
    details: { file_name: file },
    what: 'CopilotListLoadTaskFileSuccess'
  }) + '\\n');
  (async () => {
    for (const step of steps) {
      if (step.after) await sleep(step.after);
      appendLoad(step.file);
    }
    if (exitDelay) await sleep(exitDelay);
  })().then(() => process.exit(exitCode), () => process.exit(1));
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeMaaCliPath;
process.env.FAKE_MAA_CALL_LOG = maaCallLog;
process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
// 作业进度、执行锁与掉落记录都重定向到临时目录：进度存储在导入时绑定路径。
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_LOG_FILE = maaAsstLog;
process.env.MAA_CACHE_DIR = join(fixtureDir, 'maa-cache');
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_DROP_RECORDS_DIR = join(fixtureDir, 'drop-records');

const {
  buildCopilotPlan,
  buildCurrentMapStageTasks,
  buildCopilotRepeatFiles,
  buildCopilotTaskParams,
  classifyCopilotEntryOutcomes,
  ensurePresetFormationResource,
  executeCopilotEntries,
  extractLoadedCopilotFiles,
  getNavigationStage,
  isPresetFormationCopilot,
  mergePresetFormationTasks,
  resetCopilotPlanCachesForTests,
  setCopilotFileLoadPollIntervalForTests
} = await import('../copilotPlanService.ts');

beforeEach(async () => {
  resetCopilotPlanCachesForTests();
  process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
  await writeFile(maaCallLog, '');
  // 检查点读取 asst.log 的当前大小；缺失时观察与结算都没有增量可读。
  await writeFile(maaAsstLog, '', { flag: 'a' });
  await rm(join(fixtureDir, 'maa-execution.lock'), { force: true });
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

/** 同编队兼容组的两条普通作业条目：一次 MAA 命令按 copilot_list 顺序执行。 */
function groupEntriesFor(): CopilotPlanEntry[] {
  return [0, 1].map(itemIndex => ({
    key: `${itemIndex}:${100 + itemIndex}:normal`,
    itemIndex,
    copilotId: 100 + itemIndex,
    stageId: `main_01-0${itemIndex + 1}`,
    displayStage: `1-${itemIndex + 1}`,
    apCost: 6,
    mode: 'normal' as const,
    presetFormation: false
  }));
}

/** 作业内容与计划文件路径都按执行端的写入约定推导；假 CLI 按这些路径回放加载回调。 */
function planFileOf(setId: string, entry: CopilotPlanEntry): string {
  return join(maaConfigDir, 'copilot-plans', setId, `${entry.itemIndex}-${entry.copilotId}-${entry.mode}-1.json`);
}

/** 作业站内容桩：prepareCopilotList 按 copilotId 抓取作业 JSON。 */
function stubCopilotContent(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request) => {
    const match = String(url).match(/copilot\/get\/(\d+)$/);
    assert.ok(match, `unexpected outbound request: ${String(url)}`);
    const data = {
      content: JSON.stringify({
        stage_name: `main_01-0${Number(match[1]) - 99}`,
        doc: { title: 'T-1' },
        opers: [{ name: 'A' }],
        groups: []
      })
    };
    return new Response(JSON.stringify({ status_code: 200, data }), { status: 200 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('copilot group advances entries one by one as MAA loads each plan file', async () => {
  const setId = 'observe-success';
  const entries = groupEntriesFor();
  process.env.FAKE_RUN_STEPS = JSON.stringify([
    { file: planFileOf(setId, entries[0]), after: 60 },
    { file: planFileOf(setId, entries[1]), after: 400 }
  ]);
  process.env.FAKE_RUN_EXIT_CODE = '0';
  process.env.FAKE_RUN_EXIT_DELAY = '300';
  setCopilotFileLoadPollIntervalForTests(20);
  const restoreFetch = stubCopilotContent();

  const events: string[] = [];
  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: '观察作业集',
      entries,
      options: {},
      lifecycle: {
        // 生命周期签名接受更宽的条目类型；集合执行只会回传传入的计划条目。
        onEntryStarted: entry => events.push(`started:${(entry as CopilotPlanEntry).key}`),
        onEntrySettled: (entry, status) => events.push(`settled:${(entry as CopilotPlanEntry).key}:${status}`)
      }
    });

    assert.equal(outcome.success, true);
    assert.equal(outcome.stopped, false);
    // 逐项 running：第二条目在它的计划文件被 MAA 加载后才开始，不随组批量置位。
    assert.deepEqual(events.filter(event => event.startsWith('started:')), [
      `started:${entries[0].key}`,
      `started:${entries[1].key}`
    ]);
    // 逐项 success：第一条目在组结束前（第二条目文件加载时）已结算成功。
    const startedSecond = events.indexOf(`started:${entries[1].key}`);
    const settledFirst = events.indexOf(`settled:${entries[0].key}:success`);
    assert.ok(settledFirst >= 0, 'first entry should settle before the group ends');
    assert.ok(settledFirst < startedSecond, 'first entry should settle when the second plan file loads');
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'success'],
      [entries[1].key, 'success']
    ]);
    assert.deepEqual(outcome.completed, [entries[0].key, entries[1].key]);
  } finally {
    restoreFetch();
    for (const key of ['FAKE_RUN_STEPS', 'FAKE_RUN_EXIT_CODE', 'FAKE_RUN_EXIT_DELAY']) {
      delete process.env[key];
    }
  }
});

test('copilot group failure keeps confirmed entries as success and fails the rest', async () => {
  const setId = 'observe-failure';
  const entries = groupEntriesFor();
  process.env.FAKE_RUN_STEPS = JSON.stringify([
    { file: planFileOf(setId, entries[0]), after: 40 },
    { file: planFileOf(setId, entries[1]), after: 160 }
  ]);
  process.env.FAKE_RUN_EXIT_CODE = '3';
  process.env.FAKE_RUN_EXIT_DELAY = '60';
  setCopilotFileLoadPollIntervalForTests(20);
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: '失败作业集',
      entries,
      options: {}
    });

    assert.equal(outcome.success, false);
    assert.equal(outcome.stopped, false);
    // 已完整加载（后续文件开始加载）的条目按逐项 success 结算，未完成的按 failed。
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'success'],
      [entries[1].key, 'failed']
    ]);
    assert.deepEqual(outcome.completed, [entries[0].key]);
    assert.deepEqual(
      outcome.results.map(result => [result.key, result.success, result.error !== undefined]),
      [[entries[0].key, true, false], [entries[1].key, false, true]]
    );
  } finally {
    restoreFetch();
    for (const key of ['FAKE_RUN_STEPS', 'FAKE_RUN_EXIT_CODE', 'FAKE_RUN_EXIT_DELAY']) {
      delete process.env[key];
    }
  }
});
