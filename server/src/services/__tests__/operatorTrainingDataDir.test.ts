import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loggerManager } from '../../utils/logger.ts';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

type ExecFileCallback = (error: (Error & { stderr?: string }) | null, stdout: string, stderr: string) => void;
type ExecFileOverride = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback
) => void;

// ESM 命名导入在模块加载时快照，必须在动态 import 服务前替换底层实现。
const originalExecFile = childProcess.execFile;
let execFileOverride: ExecFileOverride | null = null;
childProcess.execFile = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback
) => {
  if (execFileOverride) return execFileOverride(file, args, options, callback);
  return originalExecFile(file, args, options, callback);
};

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'la-pluma-training-data-'));
process.env.LA_PLUMA_TRAINING_DATA_DIR = dataDirectory;

const { default: operatorTrainingService } = await import('../operatorTrainingService.ts');
loggerManager.getLogger('OperatorTraining').enableConsole = false;

after(async () => {
  childProcess.execFile = originalExecFile;
  delete process.env.LA_PLUMA_TRAINING_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('training data directory', () => {
  it('reads and reports fetched material data from LA_PLUMA_TRAINING_DATA_DIR', async () => {
    await mkdir(path.join(dataDirectory, 'user-configs'), { recursive: true });
    await writeFile(path.join(dataDirectory, 'materials.json'), JSON.stringify({
      materials: {
        '30011': { name: '固源岩' },
        '30012': { name: '固源岩组' },
        '30013': { name: '提纯源岩' }
      },
      recipes: {
        '30012': { materials: { '30011': 3 } },
        '30013': { materials: { '30012': 3 } }
      }
    }));
    await writeFile(path.join(dataDirectory, 'material-formulas.json'), JSON.stringify({}));
    await writeFile(path.join(dataDirectory, 'operator-materials.json'), JSON.stringify({
      operators: {
        alpha: { name: '阿尔法' },
        beta: { name: '贝塔' }
      },
      metadata: {}
    }));
    await writeFile(path.join(dataDirectory, 'penguin-drop-data.json'), JSON.stringify({
      stages: {
        'main_01-07': { code: '1-7' },
        'main_02-01': { code: '2-1' },
        'main_03-01': { code: '3-1' }
      }
    }));

    execFileOverride = (_file, _args, _options, callback) => callback(null, 'ok', '');

    const summary = await operatorTrainingService.fetchOperatorMaterials();

    assert.ok(summary.scripts.every(script => script.success));
    assert.deepEqual(summary.scripts.map(script => script.entries), [3, 0, 3, 2, 1]);
    assert.equal(summary.operatorCount, 2);
    assert.equal(summary.materialCount, 3);
    assert.equal(summary.recipeCount, 2);
  });
});
