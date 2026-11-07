import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loggerManager } from '../../utils/logger.ts';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'la-pluma-oper-recognition-'));
const trainingDataDir = path.join(fixtureRoot, 'training');
const resourceDir = path.join(fixtureRoot, 'resource');
process.env.LA_PLUMA_TRAINING_DATA_DIR = trainingDataDir;
process.env.MAA_RESOURCE_DIR = resourceDir;
await mkdir(trainingDataDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
await writeFile(path.join(resourceDir, 'battle_data.json'), JSON.stringify({
  chars: {
    char_alpha: { name: '甲', rarity: 6, profession: 'CASTER', position: 'RANGED' },
    char_beta: { name: '乙', rarity: 5, profession: 'MEDIC', position: 'RANGED' },
    char_gamma: { name: '丙', rarity: 4, profession: 'PIONEER', position: 'MELEE' }
  }
}), 'utf-8');
await writeFile(path.join(trainingDataDir, 'operator-materials.json'), JSON.stringify({
  operators: {
    char_alpha: { name: '甲', rarity: 6, profession: 'CASTER', elite2: { lmd: 0, materials: [] } },
    char_beta: { name: '乙', rarity: 5, profession: 'MEDIC', elite1: { lmd: 0, materials: [] } }
  },
  metadata: {}
}), 'utf-8');

const { default: operatorTrainingService } = await import('../operatorTrainingService.ts');
loggerManager.getLogger('OperatorTraining').enableConsole = false;
loggerManager.getLogger('DataParser').enableConsole = false;

const OPERBOX_PATH = path.join(trainingDataDir, 'operbox.json');
const ownedAlpha = { id: 'char_alpha', name: '甲', rarity: 6, elite: 1, level: 80, potential: 6, own: true };

async function writeOperBox(value: unknown): Promise<void> {
  await writeFile(OPERBOX_PATH, JSON.stringify(value), 'utf-8');
}

after(async () => {
  delete process.env.LA_PLUMA_TRAINING_DATA_DIR;
  delete process.env.MAA_RESOURCE_DIR;
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('operator recognition completeness', () => {
  it('reports every catalog operator as unrecognized before the first recognition', async () => {
    const { operators, recognition } = await operatorTrainingService.getOperatorList();

    assert.deepEqual(recognition, {
      status: 'missing',
      recognizedAt: null,
      total: 3,
      owned: 0,
      unknown: 3,
      missing: ['char_alpha', 'char_beta', 'char_gamma']
    });
    assert.deepEqual(operators.map(operator => [operator.id, operator.ownership]), [
      ['char_alpha', 'unknown'],
      ['char_beta', 'unknown'],
      ['char_gamma', 'unknown']
    ]);
    assert.ok(operators.every(operator => operator.disabledReason === 'unrecognized'));
  });

  it('confirms owned and unowned candidates from a complete recognition catalog', async () => {
    await writeOperBox({
      timestamp: '2026-11-06T00:00:00.000Z',
      operCount: 1,
      data: [ownedAlpha],
      allOpers: [
        { id: 'char_alpha', name: '甲', names: { en: 'Alpha' }, rarity: 6, owned: true },
        { id: 'char_beta', name: '乙', rarity: 5, owned: false },
        { id: 'char_gamma', name: '丙', rarity: 4, owned: false },
        { id: 'char_delta', name: '丁', names: { en: 'Delta' }, rarity: 6, owned: false }
      ],
      operTotal: 4,
      recognition: { status: 'complete', total: 4, owned: 1 }
    });

    const { operators, recognition } = await operatorTrainingService.getOperatorList();
    const byId = Object.fromEntries(operators.map(operator => [operator.id, operator] as const));

    assert.deepEqual(recognition, {
      status: 'complete',
      recognizedAt: '2026-11-06T00:00:00.000Z',
      total: 4,
      owned: 1,
      unknown: 0,
      missing: []
    });
    assert.equal(byId.char_alpha.ownership, 'owned');
    assert.equal(byId.char_alpha.canTrain, true);
    assert.equal(byId.char_beta.ownership, 'unowned');
    assert.equal(byId.char_beta.trainingStatus, 'unowned');
    assert.equal(byId.char_gamma.ownership, 'unowned');
    assert.equal(byId.char_delta.ownership, 'unowned');
    // 识别目录补充本地目录缺失的干员，名称与稀有度来自识别载荷。
    assert.equal(byId.char_delta.name, '丁');
    assert.equal(byId.char_delta.rarity, 6);
  });

  it('keeps catalog entries unknown when the scan behind the snapshot was partial', async () => {
    await writeOperBox({
      timestamp: '2026-11-06T00:00:00.000Z',
      operCount: 1,
      data: [ownedAlpha],
      allOpers: [
        { id: 'char_alpha', name: '甲', rarity: 6, owned: true },
        { id: 'char_beta', name: '乙', rarity: 5, owned: false },
        { id: 'char_gamma', name: '丙', rarity: 4, owned: false }
      ],
      operTotal: 3,
      recognition: { status: 'partial', total: 3, owned: 1 }
    });

    const { operators, recognition } = await operatorTrainingService.getOperatorList();
    const byId = Object.fromEntries(operators.map(operator => [operator.id, operator] as const));

    assert.deepEqual(recognition, {
      status: 'partial',
      recognizedAt: '2026-11-06T00:00:00.000Z',
      total: 3,
      owned: 1,
      unknown: 2,
      missing: ['char_beta', 'char_gamma']
    });
    assert.equal(byId.char_alpha.ownership, 'owned');
    assert.equal(byId.char_beta.ownership, 'unknown');
    assert.equal(byId.char_beta.disabledReason, 'unrecognized');
    assert.equal(byId.char_gamma.ownership, 'unknown');
  });

  it('keeps operators outside the recognized catalog unknown for legacy caches', async () => {
    await writeOperBox({
      timestamp: '2026-11-05T00:00:00.000Z',
      operCount: 1,
      data: [ownedAlpha]
    });

    const { operators, recognition } = await operatorTrainingService.getOperatorList();
    const byId = Object.fromEntries(operators.map(operator => [operator.id, operator] as const));

    assert.deepEqual(recognition, {
      status: 'partial',
      recognizedAt: '2026-11-05T00:00:00.000Z',
      total: 3,
      owned: 1,
      unknown: 2,
      missing: ['char_beta', 'char_gamma']
    });
    assert.equal(byId.char_alpha.ownership, 'owned');
    assert.equal(byId.char_beta.ownership, 'unknown');
    assert.equal(byId.char_beta.disabledReason, 'unrecognized');
    assert.equal(byId.char_gamma.ownership, 'unknown');
  });

  it('keeps the owned operators usable when the local training catalog cannot be read', async () => {
    await rm(path.join(resourceDir, 'battle_data.json'), { force: true });
    await writeOperBox({
      timestamp: '2026-11-06T00:00:00.000Z',
      operCount: 1,
      data: [ownedAlpha],
      allOpers: [
        { id: 'char_alpha', name: '甲', rarity: 6, owned: true },
        { id: 'char_beta', name: '乙', rarity: 5, owned: false }
      ],
      operTotal: 2,
      recognition: { status: 'complete', total: 2, owned: 1 }
    });

    const { operators, recognition } = await operatorTrainingService.getOperatorList();

    assert.deepEqual(recognition, {
      status: 'complete',
      recognizedAt: '2026-11-06T00:00:00.000Z',
      total: 2,
      owned: 1,
      unknown: 0,
      missing: []
    });
    assert.deepEqual(operators.map(operator => [operator.id, operator.ownership]), [
      ['char_alpha', 'owned'],
      ['char_beta', 'unowned']
    ]);
  });
});
