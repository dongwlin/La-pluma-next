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
const { default: operatorTrainingService, expandMaterialTree } = await import('../operatorTrainingService.js');
const { loggerManager } = await import('../../utils/logger.js');
loggerManager.getLogger('OperatorTraining').enableConsole = false;

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

    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.file === process.execPath));
    assert.match(calls[0].args[0], /scripts[\/\\]fetch-all-materials\.js$/);
    assert.equal(calls[0].options.cwd, serverDir);
    assert.equal(calls[0].options.timeout, 5 * 60 * 1000);

    assert.deepEqual(summary.scripts.map(script => script.name), [
      'fetch-all-materials',
      'fetch-material-formulas',
      'merge-formulas',
      'fetch-operator-materials'
    ]);
    assert.deepEqual(summary.scripts.map(script => script.output), [
      'materials.json',
      'material-formulas.json',
      'materials.json',
      'operator-materials.json'
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
      assert.match(error.message, /1\/4 个脚本失败/);
      assert.match(error.message, /fetch-material-formulas/);
      assert.match(error.message, /HTTP error! status: 404/);
      return true;
    });

    assert.deepEqual(executedScripts, [
      'fetch-all-materials.js',
      'fetch-material-formulas.js',
      'merge-formulas.js',
      'fetch-operator-materials.js'
    ]);
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
