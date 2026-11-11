import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import type { CopilotPlanEntry, CopilotQueuePlanEntry } from '../copilotPlanService.ts';

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
} else if (args[0] === 'dir' && (args[1] === 'hot-update' || args[1] === 'data')) {
  process.stdout.write('');
} else if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'log') {
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else if (args[0] === 'run') {
  const steps = JSON.parse(process.env.FAKE_RUN_STEPS || '[]');
  const exitCodes = JSON.parse(process.env.FAKE_RUN_EXIT_CODES || '[]');
  let exitCode = Number(process.env.FAKE_RUN_EXIT_CODE || 0);
  if (exitCodes.length > 0) {
    let index = 0;
    if (process.env.FAKE_RUN_COUNTER_FILE) {
      try { index = Number(fs.readFileSync(process.env.FAKE_RUN_COUNTER_FILE, 'utf8')) || 0; } catch {}
      fs.writeFileSync(process.env.FAKE_RUN_COUNTER_FILE, String(index + 1));
    }
    exitCode = Number(exitCodes[index] ?? 0);
  }
  const exitDelay = Number(process.env.FAKE_RUN_EXIT_DELAY || 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const appendCallback = (callback, payload) => fs.appendFileSync(process.env.FAKE_MAA_LOG_FILE || '', 'Assistant::append_callback | ' + callback + ' ' + JSON.stringify({ taskchain: 'Copilot', ...payload }) + '\\n');
  const appendLoad = (file) => appendCallback('SubTaskExtraInfo', {
    details: { stage_name: 'main_01-01', file_name: file },
    what: 'CopilotListLoadTaskFileSuccess'
  });
  (async () => {
    if (process.env.FAKE_RUN_QUEUE_BATCH_FAILURE) {
      const { basename, join } = require('node:path');
      const taskFile = join(process.env.FAKE_MAA_CONFIG_DIR, 'tasks', args[1] + '.toml');
      const task = fs.readFileSync(taskFile, 'utf8');
      const paths = Array.from(task.matchAll(/"filename" = ("(?:[^"\\\\]|\\\\.)*")/g), match => JSON.parse(match[1]));
      fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, 'copilot_list ' + paths.map(path => basename(path)).join(' ') + '\\n');
      if (exitCode) {
        appendCallback('TaskChainStart', {});
        for (const path of paths.slice(0, Number(process.env.FAKE_RUN_QUEUE_BATCH_FAILURE))) {
          appendCallback('SubTaskStart', { subtask: 'MultiCopilotTask' });
          appendLoad(path);
        }
        if (process.env.FAKE_RUN_QUEUE_LAST_STEP_CLEARED) {
          appendCallback('SubTaskStart', { details: { task: 'StageDrops-Stars-3' } });
        }
        appendCallback('TaskChainError', {});
      }
    } else {
      for (const step of steps) {
        if (step.after) await sleep(step.after);
        appendLoad(step.file);
      }
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
  buildCopilotListEntry,
  buildCopilotQueuePlan,
  buildCurrentMapStageTasks,
  buildCopilotRepeatFiles,
  buildCopilotTaskParams,
  classifyCopilotEntryOutcomes,
  ensurePresetFormationResource,
  executeCopilotEntries,
  executeCopilotQueueEntries,
  extractLoadedCopilotFiles,
  getNavigationStage,
  isPresetFormationCopilot,
  mergePresetFormationTasks,
  resetCopilotPlanCachesForTests,
  resolveCopilotStageIdentity,
  setCopilotFileLoadPollIntervalForTests,
  setCopilotPlanPathPlatformForTests
} = await import('../copilotPlanService.ts');
const { CopilotManagedFileInvalidError } = await import('../copilotFileService.ts');

beforeEach(async () => {
  resetCopilotPlanCachesForTests();
  process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
  await writeFile(maaCallLog, '');
  await rm(join(fixtureDir, 'copilot-progress.json'), { force: true });
  await rm(join(fixtureDir, 'queue-run-counter'), { force: true });
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

function stubPlanFetch(stageName: string, difficulty?: number): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url);
    const data = text.includes('/set/get')
      ? { id: 1, name: 'set', copilot_ids: [10] }
      : text.includes('penguin-stats.io')
        ? []
        : { content: JSON.stringify({ stage_name: stageName, difficulty, doc: { title: 'T-1' }, opers: [{ name: 'A' }], groups: [] }) };
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

test('automatic set mode uses the declared difficulty in the plan and progress keys', async () => {
  const restore = stubPlanFetch('main_01-01', 2);
  try {
    const plan = await buildCopilotPlan(1, 'auto');
    assert.equal(plan.items[0]?.recommendedMode, 'raid');
    assert.deepEqual(plan.entries.map(({ key, mode }) => [key, mode]), [['0:10:raid', 'raid']]);
  } finally {
    restore();
  }
});

test('plan items carry the author description and omit blank ones', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url);
    const data = text.includes('/set/get')
      ? { id: 2, name: 'set', copilot_ids: [10, 11] }
      : text.includes('penguin-stats.io')
        ? []
        : {
            content: JSON.stringify({
              stage_name: text.endsWith('/10') ? 'main_01-07' : 'main_01-08',
              doc: text.endsWith('/10')
                ? { title: '1-7', details: '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD' }
                : { title: '1-8', details: '   ' }
            })
          };
    return new Response(JSON.stringify({ status_code: 200, data }), { status: 200 });
  };
  try {
    const plan = await buildCopilotPlan('2', 'normal');
    assert.equal(
      plan.items[0]?.details,
      '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD'
    );
    assert.equal('details' in (plan.items[1] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('display stage resolves the resource code before the title code and the raw stage name', async () => {
  const resourceDir = join(fixtureDir, 'display-resource');
  const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
  await mkdir(tileDir, { recursive: true });
  await writeFile(join(resourceDir, 'stages.json'), '[]');
  await writeFile(
    join(tileDir, 'act_stage_01-activities-act_stage-level_act_stage_01.json'),
    JSON.stringify({ code: 'AT-EX-1' })
  );
  process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;

  assert.deepEqual(
    await resolveCopilotStageIdentity({
      status_code: 200,
      data: { content: JSON.stringify({ stage_name: 'act_stage_01', doc: { title: '1-7 挂机' } }) }
    }),
    { stageId: 'act_stage_01', stage: 'AT-EX-1' }
  );
  assert.deepEqual(
    await resolveCopilotStageIdentity({ content: { stage_name: 'main_99-01', doc: { title: '1-7 挂机' } } }),
    { stageId: 'main_99-01', stage: '1-7' }
  );
  assert.deepEqual(
    await resolveCopilotStageIdentity({ content: { stage_name: 'act_stage_02', doc: { title: '无代号标题' } } }),
    { stageId: 'act_stage_02', stage: 'act_stage_02' }
  );
  assert.deepEqual(await resolveCopilotStageIdentity({ content: '{}' }), { stageId: '', stage: '' });
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

test('copilot list entries carry the navigation stage name override', () => {
  assert.deepEqual(
    buildCopilotListEntry({ displayStage: 'BD-4', mode: 'normal' }, '/tmp/plan-1.json', 2),
    {
      id: 2,
      filename: '/tmp/plan-1.json',
      stage_name: 'BD-4',
      nav_name_override: 'BD-4',
      is_raid: false
    }
  );
  assert.equal(buildCopilotListEntry({ displayStage: 'BD-4', mode: 'raid' }, '/tmp/plan-2.json').is_raid, true);
});

test('user_additional is only written when auto formation is enabled', () => {
  const list = [{ filename: '/tmp/a.json' }];
  const withFormation = buildCopilotTaskParams(list, false, {
    formationMode: 'auto',
    userAdditional: [
      { name: ' 能天使 ', skill: 3 },
      { name: '', skill: 2 },
      { name: '银灰', skill: 9 }
    ]
  });
  assert.deepEqual(withFormation.user_additional, [{ name: '能天使', skill: 3 }, { name: '银灰' }]);

  const withoutFormation = buildCopilotTaskParams(list, false, {
    formationMode: 'off',
    userAdditional: [{ name: '能天使', skill: 3 }]
  });
  assert.equal('user_additional' in withoutFormation, false);
});

test('unknown stage costs stay unknown instead of becoming zero', async () => {
  const restoreFetch = stubPlanFetch('unknown_stage_01');
  try {
    const plan = await buildCopilotPlan('unknown-ap-set');
    assert.equal(plan.items[0]?.apCost, null);
  } finally {
    restoreFetch();
  }
});

test('multi-copilot loop count expands into repeated native entries', () => {
  const files = buildCopilotRepeatFiles({ itemIndex: 2, copilotId: 99, mode: 'raid' }, 3, '/tmp/plan');
  assert.equal(files.length, 3);
  assert.ok(files[0].filename.endsWith('2-99-raid-1.json'));
  assert.ok(files[2].filename.endsWith('2-99-raid-3.json'));
});

test('copilot recovery decodes escaped plan paths from MAA callbacks', () => {
  const windowsPlan = 'C:\\maa\\config\\copilot-plans\\7\\6-97353-normal-1.json';
  const log = [
    `[2026-07-10 19:55:00.000][INF] Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({
      taskchain: 'Copilot',
      taskid: 1,
      details: { stage_name: 'main_01-07', file_name: windowsPlan, id: 0 },
      what: 'CopilotListLoadTaskFileSuccess'
    })}`,
    // 增量日志的起点可能落在回调行中间：残缺 JSON 不产生条目。
    '[2026-07-10 19:55:01.000][INF] Assistant::append_callback | SubTaskExtraInfo {"taskchain":"Copilot","details":{"file_na',
    // 其他 taskchain 的同名回调不属于本次作业集执行。
    '[2026-07-10 19:55:02.000][INF] Assistant::append_callback | SubTaskExtraInfo {"taskchain":"ParadoxCopilot","details":{"file_name":"D:\\\\paradox.json"},"what":"CopilotListLoadTaskFileSuccess"}',
    `[2026-07-10 19:55:03.000][INF] Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({
      taskchain: 'Copilot',
      details: { file_name: '/tmp/6-97353-normal-2.json' },
      what: 'CopilotListLoadTaskFileSuccess'
    })}`
  ].join('\n');

  // `C:\\maa\\...` 是 JSON 转义形式，解析后应与 path.join 生成的 `C:\maa\...` 相同。
  assert.deepEqual(extractLoadedCopilotFiles(log), [windowsPlan, '/tmp/6-97353-normal-2.json']);
  assert.equal(extractLoadedCopilotFiles(log)[0], 'C:\\maa\\config\\copilot-plans\\7\\6-97353-normal-1.json');
  assert.deepEqual(extractLoadedCopilotFiles(''), []);
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

/**
 * Windows 上 MaaCore 记录的是 `path.join` 生成的同一路径，只是分隔符为 `\`，
 * 且盘符与目录名大小写由系统决定；假 CLI 按这种形式回放加载回调。
 */
function windowsPlanFileOf(setId: string, entry: CopilotPlanEntry): string {
  return planFileOf(setId, entry).toUpperCase().replace(/\//g, '\\');
}

function clearRunEnvironment(): void {
  for (const key of [
    'FAKE_RUN_STEPS',
    'FAKE_RUN_EXIT_CODE',
    'FAKE_RUN_EXIT_CODES',
    'FAKE_RUN_EXIT_DELAY',
    'FAKE_RUN_COUNTER_FILE',
    'FAKE_RUN_QUEUE_BATCH_FAILURE',
    'FAKE_RUN_QUEUE_LAST_STEP_CLEARED'
  ]) {
    delete process.env[key];
  }
}

function stubCopilotContent(onRequest?: () => void): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request) => {
    const match = String(url).match(/copilot\/get\/(\d+)$/);
    assert.ok(match, `unexpected outbound request: ${String(url)}`);
    onRequest?.();
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

test('copilot group failure does not settle an entry from its own plan file load', async () => {
  const setId = 'observe-self-load';
  const entries = groupEntriesFor();
  // 只回放第一条目自己的文件加载，随后命令失败：自己的加载不能证明完成。
  process.env.FAKE_RUN_STEPS = JSON.stringify([{ file: planFileOf(setId, entries[0]), after: 40 }]);
  process.env.FAKE_RUN_EXIT_CODE = '3';
  process.env.FAKE_RUN_EXIT_DELAY = '120';
  setCopilotFileLoadPollIntervalForTests(20);
  const restoreFetch = stubCopilotContent();

  const events: string[] = [];
  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: '自我加载',
      entries,
      options: {},
      lifecycle: {
        onEntryStarted: entry => events.push(`started:${(entry as CopilotPlanEntry).key}`),
        onEntrySettled: (entry, status) => events.push(`settled:${(entry as CopilotPlanEntry).key}:${status}`)
      }
    });

    assert.equal(outcome.success, false);
    // 执行中的投影不把“已加载”当成“已通过”，失败结算也不会留下成功记录。
    assert.deepEqual(events.filter(event => event.endsWith(':success')), []);
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'failed'],
      [entries[1].key, 'failed']
    ]);
    assert.deepEqual(outcome.completed, []);
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

/** 假 CLI 依次回放两条 Windows 路径的加载回调；平台语义按 win32 注入。 */
function stubWindowsRun(setId: string, entries: CopilotPlanEntry[], exitCode: number, exitDelay: number): void {
  setCopilotPlanPathPlatformForTests('win32');
  process.env.FAKE_RUN_STEPS = JSON.stringify([
    { file: windowsPlanFileOf(setId, entries[0]), after: 40 },
    { file: windowsPlanFileOf(setId, entries[1]), after: 160 }
  ]);
  process.env.FAKE_RUN_EXIT_CODE = String(exitCode);
  process.env.FAKE_RUN_EXIT_DELAY = String(exitDelay);
  setCopilotFileLoadPollIntervalForTests(20);
}

test('copilot group advances Windows plan paths one by one', async () => {
  const setId = 'win-success';
  const entries = groupEntriesFor();
  stubWindowsRun(setId, entries, 0, 300);
  const restoreFetch = stubCopilotContent();
  const events: string[] = [];

  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: 'Windows 路径',
      entries,
      options: {},
      lifecycle: {
        onEntryStarted: entry => events.push(`started:${(entry as CopilotPlanEntry).key}`),
        onEntrySettled: (entry, status) => events.push(`settled:${(entry as CopilotPlanEntry).key}:${status}`)
      }
    });

    assert.equal(outcome.success, true);
    assert.deepEqual(events.filter(event => event.startsWith('started:')), [
      `started:${entries[0].key}`,
      `started:${entries[1].key}`
    ]);
    // 大小写与分隔符不同不影响匹配：第一条目在第二条目的文件加载时结算。
    assert.ok(events.indexOf(`settled:${entries[0].key}:success`) < events.indexOf(`started:${entries[1].key}`));
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'success'],
      [entries[1].key, 'success']
    ]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('copilot group stop settles Windows plan paths conservatively', async () => {
  const setId = 'win-stopped';
  const entries = groupEntriesFor();
  stubWindowsRun(setId, entries, 3, 60);
  const restoreFetch = stubCopilotContent();
  let shouldStopChecks = 0;

  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: 'Windows 停止',
      entries,
      options: {},
      lifecycle: {
        // 组启动前的检查放行；停止请求在命令结束时生效，模拟执行中被终止。
        shouldStop: () => {
          shouldStopChecks += 1;
          return shouldStopChecks > 1;
        }
      }
    });

    assert.equal(outcome.stopped, true);
    assert.equal(outcome.error, null);
    // 当前条目的文件已加载（开始执行）按 stopped 结算，已确认的第一条保留 success。
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'success'],
      [entries[1].key, 'stopped']
    ]);
    assert.deepEqual(outcome.completed, [entries[0].key]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('copilot group failure matches Windows plan paths before failing the rest', async () => {
  const setId = 'win-failed';
  const entries = groupEntriesFor();
  stubWindowsRun(setId, entries, 3, 60);
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotEntries({
      setId,
      name: 'Windows 失败',
      entries,
      options: {}
    });

    assert.equal(outcome.success, false);
    assert.equal(outcome.stopped, false);
    // 路径匹配成功，已确认条目才保留 success；不能因 Windows 分隔符把成功条目重判为失败。
    assert.deepEqual(outcome.summary.taskResults.map(result => [result.key, result.status]), [
      [entries[0].key, 'success'],
      [entries[1].key, 'failed']
    ]);
    assert.deepEqual(outcome.completed, [entries[0].key]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

function stubQueueContent(stageNames: readonly string[], difficulties: readonly number[] = []): {
  restore: () => void;
  requests: string[];
} {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url);
    requests.push(text);
    if (text.includes('penguin-stats.io')) {
      return new Response(JSON.stringify({ status_code: 200, data: [] }), { status: 200 });
    }
    const match = text.match(/copilot\/get\/(\d+)$/);
    const index = match ? Number(match[1]) - 201 : 0;
    const stageName = stageNames[index] || stageNames[0];
    const data = {
      content: JSON.stringify({
        stage_name: stageName,
        difficulty: difficulties[index],
        doc: { title: '1-7' },
        opers: [{ name: 'A' }],
        groups: []
      })
    };
    return new Response(JSON.stringify({ status_code: 200, data }), { status: 200 });
  };
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    requests
  };
}

test('queue plan maps remote prts entries in request order', async () => {
  const stub = stubQueueContent(['main_01-01', 'main_01-02']);
  try {
    const plan = await buildCopilotQueuePlan([
      { clientId: 'queue-a', source: 'prts', copilotId: 201, mode: 'normal' },
      { clientId: 'queue-b', source: 'prts', copilotId: 202, mode: 'raid' }
    ]);
    assert.deepEqual(plan.entries.map(entry => ({
      key: entry.key,
      clientId: entry.clientId,
      itemIndex: entry.itemIndex,
      copilotId: entry.copilotId,
      source: entry.source,
      stageId: entry.stageId,
      stage: entry.displayStage,
      apCost: entry.apCost,
      mode: entry.mode
    })), [
      {
        key: 'queue-a',
        clientId: 'queue-a',
        itemIndex: 0,
        copilotId: 201,
        source: 'prts',
        stageId: 'main_01-01',
        stage: '1-7',
        apCost: null,
        mode: 'normal'
      },
      {
        key: 'queue-b',
        clientId: 'queue-b',
        itemIndex: 1,
        copilotId: 202,
        source: 'prts',
        stageId: 'main_01-02',
        stage: '1-7',
        apCost: null,
        mode: 'raid'
      }
    ]);
  } finally {
    stub.restore();
  }
});

test('automatic queue mode follows declared difficulty and defaults to normal', async () => {
  const stub = stubQueueContent(['main_01-01', 'main_01-02', 'main_01-03'], [2, 3]);
  try {
    const plan = await buildCopilotQueuePlan([
      { clientId: 'raid', source: 'prts', copilotId: 201, mode: 'auto' },
      { clientId: 'both', source: 'prts', copilotId: 202, mode: 'auto' },
      { clientId: 'default', source: 'prts', copilotId: 203, mode: 'auto' }
    ]);
    assert.deepEqual(plan.entries.map(entry => [entry.clientId, entry.mode]), [
      ['raid', 'raid'], ['both', 'normal'], ['both', 'raid'], ['default', 'normal']
    ]);
  } finally {
    stub.restore();
  }
});

test('queue plan reads managed local files without contacting the copilot site', async () => {
  const dataDir = join(fixtureDir, 'queue-plan-data');
  const importDir = join(dataDir, 'copilot-imports');
  await mkdir(importDir, { recursive: true });
  const localPath = join(importDir, 'local-a.json');
  await writeFile(localPath, JSON.stringify({
    stage_name: 'main_01-07',
    doc: { title: '1-7' },
    opers: [],
    groups: []
  }));
  const stub = stubQueueContent([]);
  try {
    const plan = await buildCopilotQueuePlan([
      { clientId: 'local-a', source: 'file', filename: localPath, mode: 'raid' }
    ], { dataDir });
    const entry = plan.entries[0];
    assert.ok(entry);
    assert.equal(entry.key, 'local-a');
    assert.equal(entry.clientId, 'local-a');
    assert.equal(entry.itemIndex, 0);
    assert.equal(entry.source, 'file');
    assert.equal(entry.copilotId, -1);
    assert.equal(entry.stageId, 'main_01-07');
    assert.equal(entry.displayStage, '1-7');
    assert.equal(entry.apCost, null);
    assert.equal(entry.mode, 'raid');
    assert.equal(entry.content?.stage_name, 'main_01-07');
    assert.equal(stub.requests.some(url => url.includes('/copilot/get/')), false);
  } finally {
    stub.restore();
  }
});

test('queue plan runs preset formation once in normal mode when both modes are requested', async () => {
  const dataDir = join(fixtureDir, 'queue-preset-data');
  const importDir = join(dataDir, 'copilot-imports');
  await mkdir(importDir, { recursive: true });
  const filename = join(importDir, 'preset.json');
  await writeFile(filename, JSON.stringify({ stage_name: 'act21mini_s01', opers: [], groups: [] }));
  const stub = stubQueueContent([]);
  try {
    const plan = await buildCopilotQueuePlan([
      { clientId: 'preset', source: 'file', filename, mode: 'both' },
      { clientId: 'preset-raid', source: 'file', filename, mode: 'raid' }
    ], { dataDir });
    assert.deepEqual(plan.entries.map(entry => [entry.clientId, entry.mode, entry.presetFormation]), [
      ['preset', 'normal', true],
      ['preset-raid', 'raid', true]
    ]);
  } finally {
    stub.restore();
  }
});

test('queue plan rejects local files outside the managed import directory', async () => {
  const dataDir = join(fixtureDir, 'queue-invalid-data');
  const importDir = join(dataDir, 'copilot-imports');
  await mkdir(importDir, { recursive: true });
  const belowImport = join(importDir, 'nested', 'deeper.json');
  await mkdir(join(importDir, 'nested'), { recursive: true });
  await writeFile(belowImport, JSON.stringify({ stage_name: 'main_01-07' }));

  const outsidePath = join(dataDir, 'outside.json');
  await writeFile(outsidePath, JSON.stringify({ stage_name: 'main_01-07' }));

  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [undefined, 'filename_invalid'],
    ['', 'filename_invalid'],
    ['copilot-imports/a.json', 'filename_not_absolute'],
    [join(importDir, 'stage.txt'), 'filename_extension_invalid'],
    [`${importDir}${sep}..${sep}escape.json`, 'filename_traversal'],
    [outsidePath, 'filename_outside_import_dir'],
    [join(importDir, 'missing.json'), 'file_missing']
  ];

  for (const [filename, reason] of cases) {
    await assert.rejects(
      () => buildCopilotQueuePlan([
        { clientId: 'local-a', source: 'file', filename: String(filename ?? ''), mode: 'normal' }
      ], { dataDir }),
      error => error instanceof CopilotManagedFileInvalidError && error.reason === reason,
      `expected ${reason} for ${String(filename)}`
    );
  }

  await writeFile(belowImport, '{not json');
  await assert.rejects(
    () => buildCopilotQueuePlan([
      { clientId: 'local-a', source: 'file', filename: belowImport, mode: 'normal' }
    ], { dataDir }),
    error => error instanceof CopilotManagedFileInvalidError && error.reason === 'content_invalid_json'
  );

  await writeFile(belowImport, JSON.stringify({ doc: { title: '1-7' } }));
  await assert.rejects(
    () => buildCopilotQueuePlan([
      { clientId: 'local-a', source: 'file', filename: belowImport, mode: 'normal' }
    ], { dataDir }),
    error => error instanceof CopilotManagedFileInvalidError && error.reason === 'stage_name_invalid'
  );
});

test('queue plan rejects symlinks that escape the managed import directory', async t => {
  const dataDir = join(fixtureDir, 'queue-symlink-data');
  const importDir = join(dataDir, 'copilot-imports');
  await mkdir(importDir, { recursive: true });
  const targetPath = join(dataDir, 'outside-target.json');
  await writeFile(targetPath, JSON.stringify({ stage_name: 'main_01-07' }));
  const linkPath = join(importDir, 'escape.json');
  try {
    await symlink(targetPath, linkPath);
  } catch {
    t.skip('symlink is not supported on this platform');
    return;
  }

  await assert.rejects(
    () => buildCopilotQueuePlan([
      { clientId: 'local-a', source: 'file', filename: linkPath, mode: 'normal' }
    ], { dataDir }),
    error => error instanceof CopilotManagedFileInvalidError
      && error.reason === 'filename_outside_import_dir'
  );
});

function queueEntriesFor(count = 2): CopilotQueuePlanEntry[] {
  return Array.from({ length: count }, (_, itemIndex) => ({
    key: `queue-${itemIndex}`,
    clientId: `queue-${itemIndex}`,
    source: 'prts' as const,
    itemIndex,
    copilotId: 100 + itemIndex,
    stageId: `main_01-0${itemIndex + 1}`,
    displayStage: `1-${itemIndex + 1}`,
    apCost: 6,
    mode: 'normal' as const,
    presetFormation: false
  }));
}

function queuePlanFileOf(queueId: string, entry: CopilotQueuePlanEntry): string {
  return join(
    maaConfigDir,
    'copilot-plans',
    `queue-${queueId}`,
    `${entry.itemIndex}-${entry.copilotId}-${entry.mode}-1.json`
  );
}

test('queue execution sends compatible entries in one batch and settles each success', async () => {
  const queueId = 'run-success';
  const entries = queueEntriesFor();
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotQueueEntries({
      queueId,
      name: '成功作业队列',
      entries,
      options: {},
      failurePolicy: 'stop'
    });

    assert.equal(outcome.stopped, false);
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.statuses.map(settled => [settled.entry.clientId, settled.status]),
      [['queue-0', 'success'], ['queue-1', 'success']]
    );
    assert.deepEqual(outcome.completed, ['queue-0', 'queue-1']);
    assert.equal((await readMaaCalls()).filter(line => line.startsWith('run ')).length, 1);

    const firstPlan: unknown = JSON.parse(await readFile(queuePlanFileOf(queueId, entries[0]), 'utf8'));
    assert.equal(readObject(firstPlan).stage_name, 'main_01-01');
    const secondPlan: unknown = JSON.parse(await readFile(queuePlanFileOf(queueId, entries[1]), 'utf8'));
    assert.equal(readObject(secondPlan).stage_name, 'main_01-02');
    await assert.rejects(() => stat(join(fixtureDir, 'copilot-progress.json')));
  } finally {
    restoreFetch();
  }
});

test('queue execution with stop policy keeps later entries pending after the first failure', async () => {
  const queueId = 'run-stop-policy';
  const entries = queueEntriesFor();
  process.env.FAKE_RUN_EXIT_CODES = JSON.stringify([3, 0]);
  process.env.FAKE_RUN_COUNTER_FILE = join(fixtureDir, 'queue-run-counter');
  process.env.FAKE_RUN_QUEUE_BATCH_FAILURE = '1';
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotQueueEntries({
      queueId,
      name: '失败即停队列',
      entries,
      options: {},
      failurePolicy: 'stop'
    });

    assert.equal(outcome.stopped, false);
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.statuses.map(settled => [settled.entry.clientId, settled.status]),
      [['queue-0', 'failed'], ['queue-1', 'pending']]
    );
    assert.deepEqual(outcome.completed, []);
    assert.equal((await readMaaCalls()).filter(line => line.startsWith('run ')).length, 1);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('queue execution with continue policy restarts after the failed step in a batch', async () => {
  const queueId = 'run-continue-policy';
  const entries = queueEntriesFor(3);
  process.env.FAKE_RUN_EXIT_CODES = JSON.stringify([3, 0]);
  process.env.FAKE_RUN_COUNTER_FILE = join(fixtureDir, 'queue-run-counter');
  process.env.FAKE_RUN_QUEUE_BATCH_FAILURE = '2';
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotQueueEntries({
      queueId,
      name: '失败继续队列',
      entries,
      options: {},
      failurePolicy: 'continue'
    });

    assert.equal(outcome.stopped, false);
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.statuses.map(settled => [settled.entry.clientId, settled.status]),
      [['queue-0', 'success'], ['queue-1', 'failed'], ['queue-2', 'success']]
    );
    assert.deepEqual(outcome.completed, ['queue-0', 'queue-2']);
    assert.deepEqual((await readMaaCalls()).filter(line => line.startsWith('copilot_list ')), [
      'copilot_list 0-100-normal-1.json 1-101-normal-1.json 2-102-normal-1.json',
      'copilot_list 2-102-normal-1.json'
    ]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('queue execution does not restart an unconfirmed batch after a CLI failure', async () => {
  const queueId = 'run-unknown-batch';
  const entries = queueEntriesFor();
  process.env.FAKE_RUN_EXIT_CODES = JSON.stringify([3, 0]);
  process.env.FAKE_RUN_COUNTER_FILE = join(fixtureDir, 'queue-run-counter');
  const restoreFetch = stubCopilotContent();
  try {
    const outcome = await executeCopilotQueueEntries({ queueId, name: '未确认的队列', entries, failurePolicy: 'continue' });
    assert.match(String(outcome.error), /无法确认作业队列执行到了哪一步/);
    assert.deepEqual(outcome.statuses.map(item => item.status), ['pending', 'pending']);
    assert.equal((await readMaaCalls()).filter(line => line.startsWith('run ')).length, 1);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('queue execution keeps a completed stage when its batch cannot exit the result screen', async () => {
  const queueId = 'run-cleared-step';
  const entries = queueEntriesFor();
  process.env.FAKE_RUN_EXIT_CODES = JSON.stringify([3, 0]);
  process.env.FAKE_RUN_COUNTER_FILE = join(fixtureDir, 'queue-run-counter');
  process.env.FAKE_RUN_QUEUE_BATCH_FAILURE = '1';
  process.env.FAKE_RUN_QUEUE_LAST_STEP_CLEARED = '1';
  const restoreFetch = stubCopilotContent();
  try {
    const outcome = await executeCopilotQueueEntries({ queueId, name: '已通关的批次', entries, failurePolicy: 'continue' });
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.statuses.map(item => item.status), ['success', 'success']);
    assert.deepEqual((await readMaaCalls()).filter(line => line.startsWith('copilot_list ')), [
      'copilot_list 0-100-normal-1.json 1-101-normal-1.json',
      'copilot_list 1-101-normal-1.json'
    ]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('queue execution isolates entries after a confirmed failure before starting a batch', async () => {
  const queueId = 'run-prestart-batch';
  const entries = queueEntriesFor();
  process.env.FAKE_RUN_EXIT_CODES = JSON.stringify([3, 0, 0]);
  process.env.FAKE_RUN_COUNTER_FILE = join(fixtureDir, 'queue-run-counter');
  process.env.FAKE_RUN_QUEUE_BATCH_FAILURE = '0';
  const restoreFetch = stubCopilotContent();
  try {
    const outcome = await executeCopilotQueueEntries({ queueId, name: '批次启动失败', entries, failurePolicy: 'continue' });
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.statuses.map(item => item.status), ['success', 'success']);
    assert.deepEqual((await readMaaCalls()).filter(line => line.startsWith('copilot_list ')), [
      'copilot_list 0-100-normal-1.json 1-101-normal-1.json',
      'copilot_list 0-100-normal-1.json',
      'copilot_list 1-101-normal-1.json'
    ]);
  } finally {
    restoreFetch();
    clearRunEnvironment();
  }
});

test('queue execution stops before the next formation batch when the lifecycle asks to stop', async () => {
  const queueId = 'run-stopped';
  const entries = queueEntriesFor();
  entries[1].presetFormation = true;
  let shouldStop = false;
  const restoreFetch = stubCopilotContent();

  try {
    const outcome = await executeCopilotQueueEntries({
      queueId,
      name: '停止作业队列',
      entries,
      options: {},
      lifecycle: {
        shouldStop: () => shouldStop,
        onEntrySettled: (_entry, status) => { shouldStop ||= status === 'success'; }
      }
    });

    assert.equal(outcome.stopped, true);
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.statuses.map(settled => [settled.entry.clientId, settled.status]),
      [['queue-0', 'success'], ['queue-1', 'pending']]
    );
    assert.deepEqual(outcome.completed, ['queue-0']);
    assert.equal((await readMaaCalls()).filter(line => line.startsWith('run ')).length, 1);
  } finally {
    restoreFetch();
  }
});

test('queue execution does not launch MAA when stopped during batch preparation', async () => {
  let stopped = false;
  const restoreFetch = stubCopilotContent(() => { stopped = true; });
  try {
    const outcome = await executeCopilotQueueEntries({
      queueId: 'stop-during-prepare',
      name: '准备期间停止',
      entries: queueEntriesFor(),
      lifecycle: { shouldStop: () => stopped }
    });
    assert.equal(outcome.stopped, true);
    assert.deepEqual(outcome.statuses.map(item => item.status), ['pending', 'pending']);
    assert.equal((await readMaaCalls()).some(line => line.startsWith('run ')), false);
  } finally {
    restoreFetch();
  }
});

test('queue execution writes managed local content into the queue plan directory', async () => {
  const queueId = 'run-local';
  const localContent = {
    stage_name: 'main_01-07',
    doc: { title: '1-7' },
    opers: [],
    groups: []
  };
  const entry: CopilotQueuePlanEntry = {
    key: 'local-a',
    clientId: 'local-a',
    source: 'file',
    itemIndex: 0,
    copilotId: -1,
    stageId: 'main_01-07',
    displayStage: '1-7',
    apCost: null,
    mode: 'raid',
    presetFormation: false,
    content: localContent
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('本地条目不应访问作业站');
  };

  try {
    const outcome = await executeCopilotQueueEntries({
      queueId,
      name: '本地作业队列',
      entries: [entry],
      options: {}
    });

    assert.equal(outcome.stopped, false);
    assert.deepEqual(
      outcome.statuses.map(settled => [settled.entry.clientId, settled.status]),
      [['local-a', 'success']]
    );
    const written: unknown = JSON.parse(await readFile(queuePlanFileOf(queueId, entry), 'utf8'));
    assert.deepEqual(readObject(written), localContent);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
