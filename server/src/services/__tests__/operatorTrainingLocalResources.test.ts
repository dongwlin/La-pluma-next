import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'la-pluma-local-resource-'));
process.env.MAA_DATA_DIR = fixtureRoot;
process.env.LA_PLUMA_TRAINING_DATA_DIR = path.join(fixtureRoot, 'training');
await mkdir(process.env.LA_PLUMA_TRAINING_DATA_DIR, { recursive: true });

const {
  loadMaterialFormulas,
  loadMaterialsDatabase,
  LocalResourceError
} = await import('../operatorTrainingStore.ts');

after(async () => {
  delete process.env.MAA_DATA_DIR;
  delete process.env.LA_PLUMA_TRAINING_DATA_DIR;
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function useResourceRoot(name: string): Promise<string> {
  const dataDir = path.join(fixtureRoot, name);
  await mkdir(dataDir, { recursive: true });
  process.env.MAA_DATA_DIR = dataDir;
  return path.join(dataDir, 'resource');
}

async function writeItemIndex(resourceDir: string, value: unknown): Promise<void> {
  await mkdir(resourceDir, { recursive: true });
  await writeFile(path.join(resourceDir, 'item_index.json'), JSON.stringify(value), 'utf-8');
}

async function writeSnapshot(value: unknown): Promise<void> {
  await writeFile(
    path.join(process.env.LA_PLUMA_TRAINING_DATA_DIR as string, 'materials.json'),
    JSON.stringify(value),
    'utf-8'
  );
}

describe('training materials from local MAA resources', () => {
  it('maps material fields and formulas from item_index while keeping snapshot drop and schedule data', async () => {
    const resourceDir = await useResourceRoot('mapping');
    await writeItemIndex(resourceDir, {
      '30011': { name: '源岩', classifyType: 'MATERIAL', icon: '30011.png', rarity: 0 },
      '30012': {
        name: '固源岩',
        classifyType: 'MATERIAL',
        icon: '30012.png',
        rarity: 1,
        formula: { '30011': 3 }
      },
      '4001': { name: '龙门币', classifyType: 'NORMAL', icon: '4001.png' }
    });
    await writeSnapshot({
      materials: {
        '30012': { bestStages: [{ stage: '1-7' }], rarity: 9 }
      },
      recipes: { '30012': { materials: { '30011': 99 } } },
      stageSchedule: { monday: ['1-7'] }
    });

    const database = await loadMaterialsDatabase();

    assert.deepEqual(database.materials['30012'], {
      id: '30012',
      name: '固源岩',
      rarity: 1,
      iconId: '30012',
      bestStages: [{ stage: '1-7' }]
    });
    assert.equal(database.materials['4001'], undefined);
    assert.deepEqual(database.recipes, { '30012': { materials: { '30011': 3 } } });
    assert.deepEqual(database.stageSchedule, { monday: ['1-7'] });
    assert.deepEqual(await loadMaterialFormulas(), database.recipes);
  });

  it('invalidates cached material data after the local resource file changes', async () => {
    const resourceDir = await useResourceRoot('invalidate');
    await writeItemIndex(resourceDir, {
      '30011': { name: '源岩', classifyType: 'MATERIAL', icon: '30011.png' },
      '30012': { name: '固源岩', classifyType: 'MATERIAL', formula: { '30011': 3 } }
    });
    assert.equal((await loadMaterialsDatabase()).materials['30011'].name, '源岩');

    await new Promise(resolve => setTimeout(resolve, 20));
    await writeItemIndex(resourceDir, {
      '30011': { name: '源岩（新）', classifyType: 'MATERIAL', icon: '30011.png' },
      '30012': { name: '固源岩', classifyType: 'MATERIAL', formula: { '30011': 4 } }
    });

    const refreshed = await loadMaterialsDatabase();
    assert.equal(refreshed.materials['30011'].name, '源岩（新）');
    assert.deepEqual(refreshed.recipes?.['30012'], { materials: { '30011': 4 } });
  });

  it('reads material entries from item_table.json when present', async () => {
    const resourceDir = await useResourceRoot('item-table');
    await mkdir(path.join(resourceDir, 'gamedata', 'excel'), { recursive: true });
    await writeFile(path.join(resourceDir, 'gamedata', 'excel', 'item_table.json'), JSON.stringify({
      items: {
        '30011': { itemType: 'MATERIAL', name: '源岩', rarity: 0, iconId: 'rock' },
        '30012': { itemType: 'MATERIAL', name: '固源岩', rarity: 1 }
      }
    }), 'utf-8');
    await writeItemIndex(resourceDir, {
      '30012': { name: '固源岩', classifyType: 'MATERIAL', formula: { '30011': 3 } }
    });

    const database = await loadMaterialsDatabase();

    assert.equal(database.materials['30011'].name, '源岩');
    assert.equal(database.materials['30011'].iconId, 'rock');
    assert.deepEqual(database.recipes, { '30012': { materials: { '30011': 3 } } });
  });

  it('rejects a missing local resource instead of returning an empty database', async () => {
    await useResourceRoot('missing');

    await assert.rejects(loadMaterialsDatabase(), (error: unknown) => {
      assert.ok(error instanceof LocalResourceError);
      assert.equal(error.code, 'LOCAL_RESOURCE_MISSING');
      assert.match(error.message, /item_table\.json/);
      assert.match(error.message, /item_index\.json/);
      return true;
    });
  });

  it('reports the missing field and entry when a material has no name', async () => {
    const resourceDir = await useResourceRoot('missing-field');
    await writeItemIndex(resourceDir, {
      '30011': { classifyType: 'MATERIAL', icon: '30011.png' }
    });

    await assert.rejects(loadMaterialsDatabase(), (error: unknown) => {
      assert.ok(error instanceof LocalResourceError);
      assert.equal(error.field, '30011.name');
      assert.match(error.message, /30011\.name/);
      return true;
    });
  });
});
