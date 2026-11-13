import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 资源消费者的生效目录与按文件解析必须跟随 cli.toml 的资源源：候选目录为
// 「MaaCore 附带资源 → 资源源基础资源」的加载序，按文件自后向前取第一个存在的
// 版本；更新成功后候选目录缓存必须失效，MirrorChyan 快照迁移才能被消费者看见。
// 假 CLI 在子进程里按 env/marker 切换输出，导前设置 MAA_CLI_PATH。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-resource-file-resolution-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const coreResourceDir = join(fixtureDir, 'maa-core-resource');
const checkoutADir = join(fixtureDir, 'checkout-a');
const checkoutBDir = join(fixtureDir, 'checkout-b');
const pinnedDir = join(fixtureDir, 'pinned-resource');
const dataDir = join(fixtureDir, 'maa-data');
const configDir = join(fixtureDir, 'maa-config');
const hotUpdateFailMarker = join(fixtureDir, 'fail-resource-dir');

await mkdir(coreResourceDir, { recursive: true });
await mkdir(join(checkoutADir, 'resource'), { recursive: true });
await mkdir(join(checkoutBDir, 'resource'), { recursive: true });
await mkdir(pinnedDir, { recursive: true });
await mkdir(configDir, { recursive: true });
await writeFile(join(coreResourceDir, 'battle_data.json'), JSON.stringify({
  chars: { char_base: { name: '基础干员', rarity: 3 } }
}), 'utf-8');
await writeFile(join(coreResourceDir, 'version.json'), JSON.stringify({ last_updated: '2026-11-01 00:00:00.000' }), 'utf-8');
await writeFile(join(checkoutADir, 'resource', 'battle_data.json'), JSON.stringify({
  chars: {
    char_base: { name: '基础干员', rarity: 3 },
    char_overlay: { name: '新增干员', rarity: 5 }
  }
}), 'utf-8');
await writeFile(join(checkoutBDir, 'resource', 'battle_data.json'), JSON.stringify({
  chars: { char_base: { name: '基础干员', rarity: 3 } }
}), 'utf-8');
await writeFile(join(pinnedDir, 'battle_data.json'), JSON.stringify({
  chars: { char_base: { name: '基础干员', rarity: 3 } }
}), 'utf-8');
await writeFile(join(configDir, 'cli.toml'), '[resource.source]\ntype = "git"\n', 'utf-8');

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_MAA_RESOURCE_FAIL_MARKER && fs.existsSync(process.env.FAKE_MAA_RESOURCE_FAIL_MARKER)) {
  process.stderr.write('resource dir lookup failed\\n');
  process.exit(1);
}
if (args[0] === 'dir') {
  const outputs = {
    resource: process.env.FAKE_MAA_CORE_RESOURCE_DIR,
    'hot-update': process.env.FAKE_MAA_HOT_UPDATE_DIR,
    data: process.env.FAKE_MAA_DATA_DIR,
    config: process.env.FAKE_MAA_CONFIG_DIR
  };
  if (outputs[args[1]] === undefined) process.exit(1);
  process.stdout.write(outputs[args[1]]);
  process.exit(0);
}
if (args[0] === 'hot-update') process.exit(0);
process.exit(1);
`, { mode: 0o755 });

delete process.env.MAA_RESOURCE_DIR;
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.MAA_DATA_DIR = dataDir;
process.env.FAKE_MAA_CORE_RESOURCE_DIR = coreResourceDir;
process.env.FAKE_MAA_HOT_UPDATE_DIR = checkoutADir;
process.env.FAKE_MAA_DATA_DIR = dataDir;
process.env.FAKE_MAA_CONFIG_DIR = configDir;
process.env.FAKE_MAA_RESOURCE_FAIL_MARKER = hotUpdateFailMarker;

const trainingDataDir = join(fixtureDir, 'training-data');
const copilotConfigDir = join(fixtureDir, 'copilot-config');
const copilotProgressPath = join(fixtureDir, 'copilot-progress.json');
await mkdir(trainingDataDir, { recursive: true });
await mkdir(copilotConfigDir, { recursive: true });
await mkdir(join(checkoutADir, 'resource', 'gamedata', 'excel'), { recursive: true });
await mkdir(join(checkoutADir, 'resource', 'tasks'), { recursive: true });
await writeFile(join(checkoutADir, 'resource', 'gamedata', 'excel', 'item_table.json'), JSON.stringify({
  items: {
    '30011': { name: '固源岩', itemType: 'MATERIAL', rarity: 2 },
    '4001': { name: '赤金', itemType: 'MATERIAL', rarity: 2, formula: { '30011': 2 } }
  }
}), 'utf-8');
await writeFile(join(checkoutADir, 'resource', 'tasks', 'tasks.json'), JSON.stringify({
  BattleStart: { maxTime: 3600000 }
}), 'utf-8');
process.env.LA_PLUMA_TRAINING_DATA_DIR = trainingDataDir;
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = copilotProgressPath;

const {
  createResourceUpdateService,
  getEffectiveResourceDirs,
  resolveEffectiveResourceFilePath,
  resetEffectiveResourceDirsCache
} = await import('../resourceUpdateService.ts');
const { getAllOperators } = await import('../dataParserService.ts');
const { loadMaterialsDatabase } = await import('../operatorTrainingStore.ts');
const { ensurePresetFormationResource } = await import('../copilotPlanService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  resetEffectiveResourceDirsCache();
  delete process.env.MAA_RESOURCE_DIR;
  process.env.FAKE_MAA_HOT_UPDATE_DIR = checkoutADir;
  return undefined;
});

test('lists resource dirs in core load order: core-shipped first, source checkout last', async () => {
  assert.deepEqual(await getEffectiveResourceDirs(), [coreResourceDir, join(checkoutADir, 'resource')]);
});

test('prefers the resource source layer when the file exists in both layers', async () => {
  const resolved = await resolveEffectiveResourceFilePath('battle_data.json');
  assert.equal(resolved, join(checkoutADir, 'resource', 'battle_data.json'));
});

test('falls back to the core-shipped resource when the file only exists there', async () => {
  const resolved = await resolveEffectiveResourceFilePath('version.json');
  assert.equal(resolved, join(coreResourceDir, 'version.json'));
});

test('returns the core-shipped path when no layer has the file', async () => {
  const resolved = await resolveEffectiveResourceFilePath('missing.json');
  assert.equal(resolved, join(coreResourceDir, 'missing.json'));
});

test('pins a single directory and skips the CLI when MAA_RESOURCE_DIR is set', async () => {
  process.env.MAA_RESOURCE_DIR = pinnedDir;
  process.env.FAKE_MAA_HOT_UPDATE_DIR = checkoutBDir;

  assert.deepEqual(await getEffectiveResourceDirs(), [pinnedDir]);
  assert.equal(
    await resolveEffectiveResourceFilePath('battle_data.json'),
    join(pinnedDir, 'battle_data.json')
  );
});

test('resolves against refreshed directories after a successful resource update', async () => {
  assert.equal(
    await resolveEffectiveResourceFilePath('battle_data.json'),
    join(checkoutADir, 'resource', 'battle_data.json')
  );

  process.env.FAKE_MAA_HOT_UPDATE_DIR = checkoutBDir;
  const service = createResourceUpdateService({
    runHotUpdate: async () => 'hot-update ok',
    withLease: async (_request, callback) => callback({
      owner: { pid: 1, source: 'test', taskName: null, command: null, startedAt: '' },
      lockPath: '/virtual/lock',
      reentrant: false,
      release: async () => {}
    })
  });
  const result = await service.updateResources();

  assert.equal(
    await resolveEffectiveResourceFilePath('battle_data.json'),
    join(checkoutBDir, 'resource', 'battle_data.json')
  );
  assert.equal(result.resource.lastUpdated, '2026-11-01 00:00:00.000');
});

test('serves the local fallback root when the CLI lookup fails without caching the failure', async () => {
  await writeFile(hotUpdateFailMarker, '1', 'utf-8');
  try {
    assert.equal(
      await resolveEffectiveResourceFilePath('battle_data.json'),
      join(dataDir, 'resource', 'battle_data.json')
    );
  } finally {
    await rm(hotUpdateFailMarker, { force: true });
  }

  assert.equal(
    await resolveEffectiveResourceFilePath('battle_data.json'),
    join(checkoutADir, 'resource', 'battle_data.json')
  );
});

test('operator directory reads battle data from the resource source layer', async () => {
  const operators = await getAllOperators();

  assert.ok(operators.some(operator => operator.id === 'char_overlay'));
  assert.ok(operators.some(operator => operator.id === 'char_base'));
});

test('training materials read the item table from the resource source layer', async () => {
  const database = await loadMaterialsDatabase();

  assert.equal(database.materials['30011']?.name, '固源岩');
  assert.deepEqual(database.recipes?.['4001'], { materials: { '30011': 2 } });
});

test('preset formation merge reads installed tasks from the resource source layer', async () => {
  await ensurePresetFormationResource(copilotConfigDir);
  const merged = JSON.parse(await readFile(join(copilotConfigDir, 'resource', 'tasks', 'tasks.json'), 'utf-8'));

  assert.equal((merged.BattleStart as { maxTime?: number }).maxTime, 3600000);
  assert.ok(Array.isArray((merged.BattleStart as { next?: unknown[] }).next));
  assert.ok(merged.LaPlumaPresetBattleConfirm);
});
