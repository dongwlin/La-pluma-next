import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

// node:child_process 的 ESM 命名导入在模块加载时快照，
// 因此必须在动态 import 服务之前挂上分发器，测试中通过 execFileOverride 替换实现
const originalExecFile = childProcess.execFile;
let execFileOverride = null;
childProcess.execFile = (file, args, options, callback) => {
  if (execFileOverride) return execFileOverride(file, args, options, callback);
  return originalExecFile(file, args, options, callback);
};

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { default: operatorTrainingService, expandMaterialTree, estimateMaterialFarming } = await import('../operatorTrainingService.js');
const { loggerManager } = await import('../../utils/logger.js');
loggerManager.getLogger('OperatorTraining').enableConsole = false;
loggerManager.getLogger('DropData').enableConsole = false;

afterEach(() => {
  execFileOverride = null;
});

describe('fetchOperatorMaterials', () => {
  it('runs all material fetch scripts sequentially and returns a summary', async () => {
    const calls = [];
    execFileOverride = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, 'ok', '');
    };

    const summary = await operatorTrainingService.fetchOperatorMaterials();

    assert.equal(calls.length, 5);
    assert.ok(calls.every(call => call.file === process.execPath));
    assert.match(calls[0].args[0], /scripts[\/\\]fetch-all-materials\.js$/);
    assert.equal(calls[0].options.cwd, serverDir);
    assert.equal(calls[0].options.timeout, 5 * 60 * 1000);

    assert.deepEqual(summary.scripts.map(script => script.name), [
      'fetch-all-materials',
      'fetch-material-formulas',
      'merge-formulas',
      'fetch-operator-materials',
      'fetch-penguin-stats'
    ]);
    assert.deepEqual(summary.scripts.map(script => script.output), [
      'materials.json',
      'material-formulas.json',
      'materials.json',
      'operator-materials.json',
      'penguin-drop-data.json'
    ]);
    assert.ok(summary.scripts.every(script => script.success === true));
    assert.equal(summary.scripts.every(script => typeof script.entries === 'number' || script.entries === null), true);
    assert.equal(typeof summary.operatorCount, 'number');
    assert.equal(typeof summary.materialCount, 'number');
    assert.equal(typeof summary.recipeCount, 'number');
  });

  it('continues with the remaining scripts and throws with stderr when one fails', async () => {
    const executedScripts = [];
    execFileOverride = (file, args, options, callback) => {
      const scriptName = path.basename(args[0]);
      executedScripts.push(scriptName);

      if (scriptName === 'fetch-material-formulas.js') {
        const error = new Error(`Command failed: node ${scriptName}`);
        error.stderr = 'HTTP error! status: 404\n';
        callback(error, '', error.stderr);
        return;
      }

      callback(null, 'ok', '');
    };

    await assert.rejects(operatorTrainingService.fetchOperatorMaterials(), error => {
      assert.match(error.message, /1\/5 个脚本失败/);
      assert.match(error.message, /fetch-material-formulas/);
      assert.match(error.message, /HTTP error! status: 404/);
      return true;
    });

    assert.deepEqual(executedScripts, [
      'fetch-all-materials.js',
      'fetch-material-formulas.js',
      'merge-formulas.js',
      'fetch-operator-materials.js',
      'fetch-penguin-stats.js'
    ]);
  });
});

/**
 * 企鹅物流掉落数据测试夹具：
 * - act99side_01 为临时活动关，效率最优但应被排除（活动结束后无法执行）
 * - main_01-01 样本数低于下限，统计不可信
 */
const TEST_DROP_DATA = {
  metadata: { source: 'test', server: 'CN', fetchedAt: '2026-10-24T00:00:00.000Z' },
  stages: {
    pro_b_1: { code: 'PR-B-1', apCost: 18, zoneId: 'weekly_1', zoneType: 'WEEKLY' },
    pro_b_2: { code: 'PR-B-2', apCost: 36, zoneId: 'weekly_1', zoneType: 'WEEKLY' },
    pro_a_1: { code: 'PR-A-1', apCost: 18, zoneId: 'weekly_2', zoneType: 'WEEKLY' },
    'main_01-07': { code: '1-7', apCost: 6, zoneId: 'main_1', zoneType: 'MAINLINE' },
    'main_01-01': { code: '1-1', apCost: 6, zoneId: 'main_0', zoneType: 'MAINLINE' },
    act99side_01: { code: 'XX-1', apCost: 9, zoneId: 'act99side_zone1', zoneType: 'ACTIVITY' }
  },
  dropMatrix: {
    '3251': [{ stageId: 'pro_b_1', expected: 0.5, samples: 3831346 }],
    '3252': [{ stageId: 'pro_b_2', expected: 0.5, samples: 8576774 }],
    '30011': [
      { stageId: 'main_01-07', expected: 1.245, samples: 2173917019 },
      { stageId: 'main_01-01', expected: 0.1, samples: 30 },
      { stageId: 'act99side_01', expected: 5, samples: 1000 }
    ]
  }
};

describe('estimateMaterialFarming', () => {
  it('estimates chip farming with real penguin stats', () => {
    const estimate = estimateMaterialFarming({ id: '3251', name: '术师芯片' }, TEST_DROP_DATA);

    assert.equal(estimate.stage, 'PR-B-1');
    assert.equal(estimate.stageId, 'pro_b_1');
    assert.equal(estimate.apCost, 18);
    assert.equal(estimate.expectedPerRun, 0.5);
    assert.equal(estimate.dataSource, 'penguin-stats');
    assert.equal(estimate.fallbackReason, null);
  });

  it('falls back to experience values for chips when drop data is unavailable', () => {
    const estimate = estimateMaterialFarming({ id: '3251', name: '术师芯片' }, null);

    assert.equal(estimate.stage, 'PR-B-1');
    assert.equal(estimate.stageId, null);
    assert.equal(estimate.apCost, 18);
    assert.equal(estimate.expectedPerRun, 0.5);
    assert.equal(estimate.dataSource, 'experience');
    assert.match(estimate.fallbackReason, /未加载/);
  });

  it('selects the most sanity-efficient permanent stage for regular materials', () => {
    const estimate = estimateMaterialFarming(
      { id: '30011', name: '源岩', bestStages: [{ stage: 'act99side_01' }] },
      TEST_DROP_DATA
    );

    // 临时活动关效率更优但被排除、main_01-01 样本不足，最终选 main_01-07
    assert.equal(estimate.stage, '1-7');
    assert.equal(estimate.stageId, 'main_01-07');
    assert.equal(estimate.apCost, 6);
    assert.equal(estimate.expectedPerRun, 1.245);
    assert.equal(estimate.dataSource, 'penguin-stats');
  });

  it('falls back to the material database best stage when drop data is unavailable', () => {
    const estimate = estimateMaterialFarming({ id: '30073', name: '扭转醇', bestStage: 'pro_a_1' }, null);

    assert.equal(estimate.stage, 'PR-A-1');
    assert.equal(estimate.stageId, 'pro_a_1');
    assert.equal(estimate.apCost, 18);
    assert.equal(estimate.expectedPerRun, 0.5);
    assert.equal(estimate.dataSource, 'experience');
    assert.match(estimate.fallbackReason, /未加载/);
  });

  it('returns null when neither drop data nor best stage exists', () => {
    const estimate = estimateMaterialFarming({ id: '30125', name: '双极纳米片' }, null);

    assert.equal(estimate, null);
  });
});

describe('expandMaterialTree', () => {
  it('falls back to farming the root material itself when formulas are circular', () => {
    const materialsDb = {
      materials: {
        a: { id: 'a', name: '甲材料' },
        b: { id: 'b', name: '乙材料' },
        c: { id: 'c', name: '丙材料' }
      }
    };
    const formulasDb = {
      a: { materials: { b: 2 } },
      b: { materials: { a: 1, c: 1 } }
    };
    const depot = { items: {} };

    // a 的配方展开经 b 又回到 a（环）：整条转换链作废，回退为 a 本身直接刷取
    const result = expandMaterialTree('a', 1, depot, materialsDb, formulasDb);

    assert.deepEqual(result, { a: 1 });
  });

  it('falls back with the exact requested quantity for real chip conversion cycles', () => {
    const materialsDb = {
      materials: {
        3241: { id: '3241', name: '狙击芯片' },
        3251: { id: '3251', name: '术师芯片' },
        32001: { id: '32001', name: '芯片助剂' }
      }
    };
    const formulasDb = {
      3241: { materials: { 3251: 3 } },
      3251: { materials: { 3241: 3 } }
    };
    const depot = { items: {} };

    // 与夜烟场景一致：需 3×术师芯片，仓库无芯片，互转配方 3:1 成环
    const result = expandMaterialTree('3251', 3, depot, materialsDb, formulasDb);

    assert.deepEqual(result, { 3251: 3 });
  });

  it('does not drop shared sub-materials across diamond-shaped formulas', () => {
    const materialsDb = {
      materials: {
        a: { id: 'a', name: '甲材料' },
        b: { id: 'b', name: '乙材料' },
        c: { id: 'c', name: '丙材料' },
        d: { id: 'd', name: '丁材料' }
      }
    };
    const formulasDb = {
      a: { materials: { b: 2, c: 1 } },
      b: { materials: { d: 1 } },
      c: { materials: { d: 2 } }
    };
    const depot = { items: {} };

    // 路径级环阻断不应误伤菱形依赖中共享的 d：b 支路 2×1 + c 支路 1×2 = 4
    const result = expandMaterialTree('a', 1, depot, materialsDb, formulasDb);

    assert.deepEqual(result, { d: 4 });
  });

  it('returns an empty result without fallback when the depot already covers the formula', () => {
    const materialsDb = {
      materials: {
        x: { id: 'x', name: '辅助双芯片' },
        y: { id: 'y', name: '辅助芯片组' },
        z: { id: 'z', name: '芯片助剂' }
      }
    };
    const formulasDb = {
      x: { materials: { y: 2, z: 1 } }
    };
    const depot = { items: { y: 100, z: 100 } };

    // 展开结果为空是仓库已覆盖的合法结果，不应触发环回退
    const result = expandMaterialTree('x', 4, depot, materialsDb, formulasDb);

    assert.deepEqual(result, {});
  });

  it('treats chip packs as directly farmable without expanding their formula', () => {
    const materialsDb = {
      materials: {
        x: { id: 'x', name: '辅助芯片组' }
      }
    };
    const formulasDb = {
      x: { materials: { y: 3 } }
    };
    const depot = { items: { x: 1 } };

    const result = expandMaterialTree('x', 4, depot, materialsDb, formulasDb);

    assert.deepEqual(result, { x: 3 });
  });
});
