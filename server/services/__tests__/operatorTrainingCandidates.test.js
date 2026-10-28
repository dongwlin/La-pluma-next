import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTrainingCandidates,
  getOperBoxOperators
} from '../operatorTrainingModel.js';

// 候选计数回归：/training/operators 的 count 与客户端三种状态计数都来自这份投影，
// 因此在不读取运行数据的前提下固定「持有 / 材料 / 精英等级」到计数与排序的映射。
const catalog = [
  { id: 'char_a', name: '甲', rarity: 6, profession: 'CASTER', position: 'RANGED' },
  { id: 'char_b', name: '乙', rarity: 5, profession: 'MEDIC', position: 'RANGED' },
  { id: 'char_c', name: '丙', rarity: 6, profession: 'CASTER', position: 'MELEE' },
  { id: 'char_d', name: '丁', rarity: 4, profession: 'PIONEER', position: 'MELEE' },
  { id: 'char_e', name: '戊', rarity: 5, profession: 'CASTER', position: 'RANGED' }
];

const operatorMaterials = {
  operators: {
    char_a: {
      name: '甲', rarity: 6, profession: 'CASTER',
      elite1: { lmd: 0, materials: [{ id: 'm1', name: '材料一', count: 2 }] },
      elite2: { lmd: 0, materials: [{ id: 'm2', name: '材料二', count: 4 }] }
    },
    char_b: { name: '乙', rarity: 5, profession: 'MEDIC', elite1: { lmd: 0, materials: [] } },
    char_e: { name: '戊', rarity: 5, profession: 'CASTER', elite1: { lmd: 0, materials: [] } }
  }
};

// char_a 可养成；char_b 已精二；char_c 缺材料数据；char_e 未持有但有材料数据；char_d 未持有
const owned = [
  { id: 'char_a', name: '甲', rarity: 6, elite: 0, level: 50, potential: 2 },
  { id: 'char_b', name: '乙', rarity: 5, elite: 2, level: 60, potential: 1 },
  { id: 'char_c', name: '丙', rarity: 6, elite: 1, level: 70, potential: 1 }
];

const ids = rows => rows.map(row => row.id);
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));

describe('training candidate projection', () => {
  it('counts trainable, owned and all candidates from the catalog', () => {
    assert.equal(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'trainable' }).length, 1);
    assert.equal(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'owned' }).length, 3);
    assert.equal(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all' }).length, 5);
    // 默认 status（未给出）与 all 一致
    assert.equal(buildTrainingCandidates(catalog, owned, operatorMaterials, {}).length, 5);
  });

  it('maps ownership, material availability and elite level to disabled reasons', () => {
    const rows = byId(buildTrainingCandidates(catalog, owned, operatorMaterials));

    assert.deepEqual(
      { canTrain: rows.char_a.canTrain, disabledReason: rows.char_a.disabledReason, trainingStatus: rows.char_a.trainingStatus },
      { canTrain: true, disabledReason: null, trainingStatus: 'trainable' }
    );
    assert.equal(rows.char_b.disabledReason, 'already_elite2');
    assert.equal(rows.char_b.canTrain, false);
    assert.equal(rows.char_c.disabledReason, 'missing_material_data');
    assert.equal(rows.char_c.canTrain, false);
    assert.equal(rows.char_d.disabledReason, 'unowned');
    assert.equal(rows.char_d.trainingStatus, 'unowned');
    // 未持有但有材料数据时仍按未持有计数，不提前标记为缺材料
    assert.equal(rows.char_e.disabledReason, 'unowned');
    assert.equal(rows.char_e.trainingStatus, 'unowned');
    assert.equal(rows.char_e.hasMaterialData, true);
  });

  it('applies rarity, profession, owned and elite filters without changing counts of other statuses', () => {
    const rarity6 = buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all', rarity: 6 });
    assert.deepEqual(ids(rarity6), ['char_a', 'char_c']);

    const casters = buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all', profession: 'CASTER' });
    assert.deepEqual(ids(casters), ['char_a', 'char_c', 'char_e']);

    const unowned = buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all', owned: false });
    assert.deepEqual(ids(unowned), ['char_e', 'char_d']);

    // needsElite2 只排除已持有且已精二的干员；未持有干员与迁移前一致地保留
    const needsElite2 = buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all', needsElite2: true });
    assert.deepEqual(ids(needsElite2), ['char_a', 'char_c', 'char_e', 'char_d']);

    // 计数使用的组合筛选在各状态内独立成立
    assert.deepEqual(
      ids(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'trainable', rarity: 6 })),
      ['char_a']
    );
    assert.deepEqual(
      ids(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'owned', profession: 'CASTER' })),
      ['char_a', 'char_c']
    );
  });

  it('keeps the legacy ordering: trainable, owned, rarity, elite and name', () => {
    const rows = buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'all' });
    assert.deepEqual(ids(rows), ['char_a', 'char_c', 'char_b', 'char_e', 'char_d']);
    assert.deepEqual(ids(buildTrainingCandidates(catalog, owned, operatorMaterials, { status: 'owned' })), ['char_a', 'char_c', 'char_b']);
  });

  it('reads both operbox shapes and carries materials through', () => {
    assert.deepEqual(getOperBoxOperators({ data: owned }), owned);
    assert.deepEqual(getOperBoxOperators({ operators: owned }), owned);
    assert.deepEqual(getOperBoxOperators({}), []);
    assert.deepEqual(getOperBoxOperators(null), []);

    const rows = byId(buildTrainingCandidates(catalog, owned, operatorMaterials));
    assert.deepEqual(rows.char_a.materials, {
      elite1: operatorMaterials.operators.char_a.elite1,
      elite2: operatorMaterials.operators.char_a.elite2
    });
    assert.equal(rows.char_a.currentElite, 0);
    assert.equal(rows.char_a.currentLevel, 50);
    assert.equal(rows.char_a.potential, 2);
    assert.equal(rows.char_a.targetElite, 2);
    assert.equal(rows.char_d.materials, null);
    assert.equal(rows.char_d.currentElite, 0);
    assert.equal(rows.char_d.currentLevel, 0);
  });
});
