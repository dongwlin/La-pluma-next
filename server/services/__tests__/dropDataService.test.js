import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { findBestFarmStage, getStageEstimate } = await import('../dropDataService.js');
const { loggerManager } = await import('../../utils/logger.ts');
loggerManager.getLogger('DropData').enableConsole = false;

// 与 scripts/fetch-penguin-stats.js 的产出同构的测试夹具
const TEST_DROP_DATA = {
  metadata: { source: 'test', server: 'CN', fetchedAt: '2026-10-24T00:00:00.000Z' },
  stages: {
    'main_01-07': { code: '1-7', apCost: 6, zoneId: 'main_1', zoneType: 'MAINLINE' },
    'main_01-01': { code: '1-1', apCost: 6, zoneId: 'main_0', zoneType: 'MAINLINE' },
    'main_14-16': { code: '14-18', apCost: 24, zoneId: 'main_14', zoneType: 'MAINLINE' },
    act99side_01: { code: 'XX-1', apCost: 9, zoneId: 'act99side_zone1', zoneType: 'ACTIVITY' },
    act19side_07_perm: { code: 'IW-7', apCost: 21, zoneId: 'permanent_sidestory_19_zone1', zoneType: 'ACTIVITY_PERMANENT' },
    pro_b_1: { code: 'PR-B-1', apCost: 18, zoneId: 'weekly_1', zoneType: 'WEEKLY' }
  },
  dropMatrix: {
    // 源岩：临时活动关效率最优但必须被排除；main_01-01 样本不足；永久关 main_01-07 应胜出
    '30011': [
      { stageId: 'main_01-07', expected: 1.245, samples: 2173917019 },
      { stageId: 'main_01-01', expected: 0.1, samples: 30 },
      { stageId: 'act99side_01', expected: 5, samples: 1000 }
    ],
    // 扭转醇：main_01-01 效率(6/0.02=300)远差于 main_14-16(24/0.712≈33.7)
    '30073': [
      { stageId: 'main_14-16', expected: 0.712, samples: 27958 },
      { stageId: 'main_01-01', expected: 0.02, samples: 100 }
    ],
    // 狙击芯片：矩阵中的 stageId 带 _perm 后缀（别传关）
    '3241': [
      { stageId: 'act19side_07_perm', expected: 0.5, samples: 5000 },
      { stageId: 'pro_b_1', expected: 0.5, samples: 3831346 }
    ]
  }
};

describe('findBestFarmStage', () => {
  it('picks the permanent stage with the lowest sanity cost per expected drop', () => {
    const best = findBestFarmStage('30073', TEST_DROP_DATA);

    assert.equal(best.stageId, 'main_14-16');
    assert.equal(best.code, '14-18');
    assert.equal(best.apCost, 24);
    assert.equal(best.expectedPerRun, 0.712);
    assert.equal(best.samples, 27958);
  });

  it('excludes temporary activity stages even when they are more efficient', () => {
    const best = findBestFarmStage('30011', TEST_DROP_DATA);

    // act99side_01（9理智/期望5）效率最优但为临时活动关，main_01-01 样本不足
    assert.equal(best.stageId, 'main_01-07');
  });

  it('resolves perm-suffixed sidestory stage ids from the matrix', () => {
    const best = findBestFarmStage('3241', TEST_DROP_DATA);

    assert.equal(best.stageId, 'pro_b_1');
  });

  it('returns null for items without matrix data', () => {
    assert.equal(findBestFarmStage('999999', TEST_DROP_DATA), null);
    assert.equal(findBestFarmStage('30011', null), null);
  });
});

describe('getStageEstimate', () => {
  it('resolves a stage by its internal stage id', () => {
    const estimate = getStageEstimate('pro_b_1', '3251', { ...TEST_DROP_DATA, dropMatrix: { '3251': [{ stageId: 'pro_b_1', expected: 0.5004, samples: 3831346 }] } });

    assert.equal(estimate.stageId, 'pro_b_1');
    assert.equal(estimate.code, 'PR-B-1');
    assert.equal(estimate.apCost, 18);
    assert.equal(estimate.expectedPerRun, 0.5004);
  });

  it('resolves a stage by its display code regardless of case', () => {
    const estimate = getStageEstimate('pr-b-1', '3251', { ...TEST_DROP_DATA, dropMatrix: { '3251': [{ stageId: 'pro_b_1', expected: 0.5, samples: 100 }] } });

    assert.equal(estimate.code, 'PR-B-1');
  });

  it('returns null when the stage or the item is missing from the data', () => {
    assert.equal(getStageEstimate('main_01-07', '999999', TEST_DROP_DATA), null);
    assert.equal(getStageEstimate('no_such_stage', '30011', TEST_DROP_DATA), null);
    assert.equal(getStageEstimate('main_01-07', '30011', null), null);
  });

  it('returns null when the stage has too few samples', () => {
    const lowSampleData = {
      ...TEST_DROP_DATA,
      dropMatrix: { '30011': [{ stageId: 'main_01-01', expected: 5, samples: 10 }] }
    };

    assert.equal(getStageEstimate('main_01-01', '30011', lowSampleData), null);
  });
});
