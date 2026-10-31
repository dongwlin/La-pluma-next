import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CombatStageObject } from '../operatorTrainingStore.ts';

// 回归：内部同步入口必须沿用连接 profile 的客户端类型。
// 固定时刻 2026-10-28T08:00Z 下，国服游戏日为周三（CE-6 关闭），美服为周二
// （CE-6 开放）；若同步退回默认客户端，已应用的 CE-6 智能关卡会被删除。
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'la-pluma-training-client-'));
const maaConfigDir = path.join(dataDirectory, 'maa-config');
const maaCacheDir = path.join(dataDirectory, 'maa-cache');
const fakeCliPath = path.join(dataDirectory, 'fake-maa-cli.js');

process.env.LA_PLUMA_TRAINING_DATA_DIR = dataDirectory;
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.LA_PLUMA_MAA_LOCK_FILE = path.join(dataDirectory, 'maa.lock');

await mkdir(path.join(dataDirectory, 'user-configs'), { recursive: true });
await mkdir(path.join(maaConfigDir, 'profiles'), { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await writeFile(path.join(maaConfigDir, 'profiles', 'default.toml'), [
  '[connection]',
  'adb_path = "/fixture/adb"',
  'address = "127.0.0.1:5555"',
  'client_type = "YoStarEN"',
  ''
].join('\n'));
// 活动表只给美服一个短窗口：2026-10-26T00:00Z 至 2026-10-27T23:59Z。
// 其它时刻与其它服务区都按周表判定，避免用例依赖宿主机。
await writeFile(path.join(maaCacheDir, 'StageActivityV2.json'), JSON.stringify({
  Official: {},
  YoStarEN: {
    resourceCollection: {
      Tip: 'SUPPLIES & CHIPS EVERYDAY ACCESS',
      UtcStartTime: '2026/10/26 00:00:00',
      UtcExpireTime: '2026/10/27 23:59:59',
      TimeZone: 0,
      IsResourceCollection: true
    }
  }
}));
await writeFile(fakeCliPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'cache') {
  process.stdout.write(process.env.MAA_CACHE_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

const { default: training } = await import('../operatorTrainingService.ts');
const { loggerManager } = await import('../../utils/logger.ts');
loggerManager.getLogger('OperatorTraining').enableConsole = false;
loggerManager.getLogger('DropData').enableConsole = false;
loggerManager.getLogger('MaaService').enableConsole = false;

const configPath = path.join(dataDirectory, 'user-configs/automation-tasks.json');
const queuePath = path.join(dataDirectory, 'user-configs/training-queue.json');

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value));
}

async function smartStages(): Promise<CombatStageObject[]> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    taskFlow: Array<{ params?: { stages?: unknown[] } }>;
  };
  return (config.taskFlow[0].params?.stages ?? []).filter(isSmartStage);
}

function isSmartStage(value: unknown): value is CombatStageObject {
  return typeof value === 'object' && value !== null && (value as CombatStageObject).smart === true;
}

beforeEach(async () => {
  await writeJson(queuePath, { queue: [], settings: {} });
  await writeJson(configPath, {
    name: '日常材料筹备',
    taskFlow: [{ id: 'fight-daily', commandId: 'fight', name: '材料作战', params: { stages: [] } }],
    schedule: { enabled: false, times: [] }
  });
  await writeJson(path.join(dataDirectory, 'operator-materials.json'), {
    operators: {
      alpha: {
        name: '夜烟',
        rarity: 5,
        profession: 'CASTER',
        elite1: { lmd: 0, materials: [{ id: 'test_alpha', name: '夜烟材料', count: 2 }] }
      },
      beta: {
        name: '调香师',
        rarity: 5,
        profession: 'MEDIC',
        elite1: { lmd: 0, materials: [{ id: 'test_beta', name: '调香师材料', count: 2 }] }
      }
    }
  });
  await writeJson(path.join(dataDirectory, 'materials.json'), {
    materials: {
      test_alpha: { id: 'test_alpha', name: '夜烟材料', bestStage: 'CE-6' },
      test_beta: { id: 'test_beta', name: '调香师材料', bestStage: 'S3-2' }
    }
  });
  await writeJson(path.join(dataDirectory, 'material-formulas.json'), {});
  await writeJson(path.join(dataDirectory, 'operbox.json'), { operators: [] });
  await writeJson(path.join(dataDirectory, 'depot.json'), { items: [] });
});

after(async () => {
  for (const key of ['LA_PLUMA_TRAINING_DATA_DIR', 'MAA_CLI_PATH', 'MAA_CACHE_DIR', 'FAKE_MAA_CONFIG_DIR', 'LA_PLUMA_MAA_LOCK_FILE']) {
    delete process.env[key];
  }
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('training plan client game day', () => {
  it('keeps the resource stage open in the profile server zone when the flow is re-synced', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 28, 8, 0, 0) });
    try {
      await training.addToQueue('alpha');
      const preview = await training.generateTrainingPlan();
      assert.deepEqual((preview.openStages ?? []).map(stage => stage.stage), ['CE-6']);
      await training.applyPlanToTasks(preview);
      assert.ok((await smartStages()).some(stage => stage.stage === 'CE-6'));

      // 队列增删触发的自动同步与显式同步都必须沿用 profile 的 YoStarEN 游戏日。
      await training.addToQueue('beta');
      assert.equal((await training.getTrainingQueue()).flowSync.status, 'synced');
      assert.ok(
        (await smartStages()).some(stage => stage.stage === 'CE-6'),
        'queue mutation must not drop CE-6 while the US game day keeps it open'
      );

      const synced = await training.syncTrainingFlow();
      assert.equal(synced.flowSync.status, 'synced');
      assert.ok((await smartStages()).some(stage => stage.stage === 'CE-6'));
    } finally {
      t.mock.timers.reset();
    }
  });

  it('opens a resource stage closed by the weekly table during a resource collection window', async (t) => {
    // 2026-10-27T08:00Z：美服游戏日为周一，CE-6 按周表关闭；活动窗口覆盖该时刻。
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 27, 8, 0, 0) });
    try {
      await training.addToQueue('alpha');

      const weekly = await training.generateTrainingPlan('current', { allResourceStagesOpen: false });
      assert.deepEqual(weekly.openStages ?? [], []);
      assert.deepEqual((weekly.closedStages ?? []).map(stage => stage.stage), ['CE-6']);

      const duringEvent = await training.generateTrainingPlan('current');
      assert.deepEqual((duringEvent.openStages ?? []).map(stage => stage.stage), ['CE-6']);
      assert.deepEqual(duringEvent.closedStages ?? [], []);
    } finally {
      t.mock.timers.reset();
    }
  });
});
