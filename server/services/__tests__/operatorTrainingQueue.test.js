import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'la-pluma-training-'));
process.env.LA_PLUMA_TRAINING_DATA_DIR = dataDirectory;
const { default: training, summarizeScheduleSync } = await import('../operatorTrainingService.js');
const { loggerManager } = await import('../../utils/logger.js');
loggerManager.getLogger('OperatorTraining').enableConsole = false;
loggerManager.getLogger('DropData').enableConsole = false;

const configPath = path.join(dataDirectory, 'user-configs/automation-tasks.json');
const queuePath = path.join(dataDirectory, 'user-configs/training-queue.json');
const normalStages = [{ stage: 'CE-6', times: '2', pinned: true }, { stage: '1-7', times: '9' }];
const operators = {
  alpha: { name: '夜烟', stage: '1-7' },
  beta: { name: '调香师', stage: 'S3-2' },
  gamma: { name: '假日威龙陈', stage: 'S4-1' }
};

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value));
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

async function smartStages() {
  const config = await readConfig();
  return config.taskFlow[0].params.stages.filter(stage => stage.smart);
}

beforeEach(async () => {
  await mkdir(path.join(dataDirectory, 'user-configs'), { recursive: true });
  await writeJson(queuePath, { queue: [], settings: {} });
  await writeJson(configPath, {
    name: '日常材料筹备',
    taskFlow: [{ id: 'fight-daily', commandId: 'fight', name: '材料作战', params: { stages: normalStages } }],
    schedule: { enabled: true, times: ['12:00'] }
  });
  await writeJson(path.join(dataDirectory, 'operator-materials.json'), {
    operators: Object.fromEntries(Object.entries(operators).map(([id, operator]) => [id, {
      name: operator.name,
      rarity: 5,
      profession: 'CASTER',
      elite1: { lmd: 0, materials: [{ id: `test_${id}`, name: `${operator.name}材料`, count: 2 }] }
    }]))
  });
  await writeJson(path.join(dataDirectory, 'materials.json'), {
    materials: Object.fromEntries(Object.entries(operators).map(([id, operator]) => [`test_${id}`, {
      id: `test_${id}`, name: `${operator.name}材料`, bestStage: operator.stage
    }]))
  });
  await writeJson(path.join(dataDirectory, 'material-formulas.json'), {});
  await writeJson(path.join(dataDirectory, 'operbox.json'), { operators: [] });
  await writeJson(path.join(dataDirectory, 'depot.json'), { items: [] });
});

after(async () => {
  delete process.env.LA_PLUMA_TRAINING_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('training queue and applied flow synchronization', () => {
  it('adds, previews, reorders and removes without writing an unapplied flow', async () => {
    const original = await readFile(configPath, 'utf8');
    const first = await training.addToQueue('alpha');
    assert.equal(first.queueUpdated, true);
    assert.equal(first.flowSync.status, 'not_applied');
    assert.equal(first.flowSync.flowName, '日常材料筹备');
    assert.equal(first.flowSync.taskName, '材料作战');
    const preview = await training.generateTrainingPlan();
    assert.equal(preview.queueRevision, first.queueRevision);
    assert.equal(preview.stages[0].sanityPerRun, preview.stages[0].apCost);
    assert.equal(preview.stages[0].sanity, preview.stages[0].sanityPerRun * preview.stages[0].totalTimes);
    await training.addToQueue('beta');
    await training.updateQueueOrder(['beta', 'alpha']);
    await training.removeFromQueue('alpha');
    await training.removeFromQueue('beta');
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal((await training.getTrainingQueue()).queue.length, 0);
    assert.equal((await training.syncTrainingFlow()).flowSync.status, 'not_applied');
  });

  it('refreshes the registered schedule from the applied task flow', async () => {
    await training.addToQueue('alpha');
    const preview = await training.generateTrainingPlan();
    const refreshed = [];
    const applied = await training.applyPlanToTasks(preview, {}, {
      refreshSchedule: async config => {
        refreshed.push(config);
        return { attempted: true, success: true, message: '已设置 1 个定时任务' };
      }
    });

    assert.equal(applied.scheduleSync.attempted, true);
    assert.equal(applied.scheduleSync.success, true);
    assert.equal(refreshed.length, 1);
    assert.deepEqual(refreshed[0].schedule, { enabled: true, times: ['12:00'] });
    const fightTask = refreshed[0].taskFlow.find(task => task.commandId === 'fight');
    const smart = fightTask.params.stages.find(stage => stage.smart);
    assert.deepEqual(smart.trainingOperators, ['夜烟']);
  });

  it('re-registers an already running schedule through the default refresher', async () => {
    const { setupSchedule, stopSchedule, getScheduleStatus } = await import('../schedulerService.js');
    const initialFlow = [{ id: 'old-fight', commandId: 'fight', params: { stages: [{ stage: '1-7', times: '1' }] } }];
    assert.equal(setupSchedule('default', ['01:00'], initialFlow).success, true);
    try {
      await training.addToQueue('alpha');
      const preview = await training.generateTrainingPlan();
      const applied = await training.applyPlanToTasks(preview);

      assert.equal(applied.scheduleSync.attempted, true);
      assert.equal(applied.scheduleSync.success, true);
      // 以 automation-tasks 为准重新注册时间与任务流程。
      assert.deepEqual(
        getScheduleStatus().find(entry => entry.scheduleId === 'default')?.times,
        ['12:00']
      );
    } finally {
      stopSchedule('default');
    }
  });

  it('reports a per-time schedule registration failure as partial', () => {
    const summary = summarizeScheduleSync(
      { success: true, message: '已设置 1 个定时任务', times: ['08:00'] },
      ['08:00', '14:00']
    );

    assert.equal(summary.attempted, true);
    assert.equal(summary.success, false);
    assert.deepEqual(summary.missingTimes, ['14:00']);
    assert.match(summary.message, /14:00/);
  });

  it('accepts a schedule registration that accepted every requested time', () => {
    const summary = summarizeScheduleSync(
      { success: true, message: '已设置 2 个定时任务', times: ['08:00', '14:00'] },
      ['08:00', '14:00']
    );

    assert.equal(summary.success, true);
    assert.equal(summary.missingTimes, undefined);
    assert.equal(summary.message, '已设置 2 个定时任务');
  });

  it('normalizes duplicate and invalid stored times before reporting missing entries', () => {
    const summary = summarizeScheduleSync(
      { success: true, message: '已设置 1 个定时任务', times: ['08:00'] },
      ['08:00', '08:00', 'not-a-time']
    );

    assert.equal(summary.success, true);
    assert.equal(summary.missingTimes, undefined);
  });

  it('reports a schedule refresh failure without discarding the applied plan', async () => {
    await training.addToQueue('alpha');
    const preview = await training.generateTrainingPlan();
    const applied = await training.applyPlanToTasks(preview, {}, {
      refreshSchedule: async () => ({
        attempted: true,
        success: false,
        message: '定时任务设置失败'
      })
    });

    assert.equal(applied.scheduleSync.attempted, true);
    assert.equal(applied.scheduleSync.success, false);
    assert.equal(applied.scheduleSync.message, '定时任务设置失败');
    assert.equal((await training.getTrainingQueue()).flowSync.status, 'synced');
    assert.ok((await smartStages()).length > 0);
  });

  it('clears the only target and restores it in place while preserving ordinary stages', async () => {
    await training.addToQueue('alpha', { currentElite: 0, targetElite: 1 });
    const applied = await training.applyPlanToTasks(await training.generateTrainingPlan());
    assert.equal(applied.flowName, '日常材料筹备');
    assert.equal(applied.taskName, '材料作战');
    assert.equal((await smartStages()).length, 1);

    // A smart stage remains managed even if someone pinned it in the task editor.
    const config = await readConfig();
    config.taskFlow[0].params.stages.find(stage => stage.smart).pinned = true;
    await writeJson(configPath, config);
    const removed = await training.removeFromQueue('alpha');
    assert.equal(removed.flowSync.status, 'synced');
    assert.deepEqual((await readConfig()).taskFlow[0].params.stages, normalStages);
    assert.deepEqual((await readConfig()).schedule, { enabled: true, times: ['12:00'] });

    const restored = await training.addToQueue('alpha', { currentElite: 0, targetElite: 1, position: 0 });
    assert.equal(restored.flowSync.status, 'synced');
    assert.deepEqual((await smartStages())[0].trainingOperators, ['夜烟']);
    assert.equal((await training.getTrainingQueue()).queue[0].targetElite, 1);
  });

  it('synchronizes additions, sorting, removal and undo to the current target without dropping items', async () => {
    await training.addToQueue('alpha');
    await training.applyPlanToTasks(await training.generateTrainingPlan());
    const added = await training.addToQueue('beta');
    assert.equal(added.flowSync.status, 'synced');
    await training.addToQueue('gamma');
    const sorted = await training.updateQueueOrder(['beta', 'gamma', 'alpha']);
    assert.equal(sorted.flowSync.status, 'synced');
    assert.deepEqual((await smartStages())[0].trainingOperators, ['调香师']);
    await training.removeFromQueue('gamma');
    await training.addToQueue('gamma', { position: 1 });
    assert.deepEqual((await training.getTrainingQueue()).queue.map(item => item.operatorId), ['beta', 'gamma', 'alpha']);
    await training.removeFromQueue('beta');
    assert.deepEqual((await smartStages())[0].trainingOperators, ['假日威龙陈']);

    await assert.rejects(training.updateQueueOrder(['alpha']), /全部养成干员/);
    await assert.rejects(training.updateQueueOrder(['alpha', 'alpha']), /不能重复/);
    assert.deepEqual((await training.getTrainingQueue()).queue.map(item => item.operatorId), ['gamma', 'alpha']);
  });

  it('reports a committed queue and failed flow separately and retries without repeating the queue change', async () => {
    await training.addToQueue('alpha');
    await training.addToQueue('beta');
    await training.applyPlanToTasks(await training.generateTrainingPlan());
    const originalConfig = await readFile(configPath, 'utf8');
    await writeFile(configPath, '{ invalid JSON');
    const removed = await training.removeFromQueue('alpha');
    assert.equal(removed.queueUpdated, true);
    assert.equal(removed.flowSync.status, 'failed');
    assert.ok(removed.flowSync.error);
    assert.deepEqual((await training.getTrainingQueue()).queue.map(item => item.operatorId), ['beta']);
    assert.equal((await training.getTrainingQueue()).flowSync.status, 'failed');

    await writeFile(configPath, originalConfig);
    const retried = await training.syncTrainingFlow();
    assert.equal(retried.queueUpdated, false);
    assert.equal(retried.queueRevision, removed.queueRevision);
    assert.equal(retried.flowSync.status, 'synced');
    assert.deepEqual((await smartStages())[0].trainingOperators, ['调香师']);
  });

  it('keeps the explicitly applied all-target mode during subsequent synchronization', async () => {
    await training.addToQueue('alpha');
    await training.applyPlanToTasks(await training.generateTrainingPlan('all'));
    await training.addToQueue('beta');
    assert.deepEqual((await smartStages())[0].trainingOperators, ['夜烟', '调香师']);
    assert.equal((await training.getTrainingQueue()).flowSync.mode, 'all');
  });

  it('rejects missing or stale preview revisions before changing the flow', async () => {
    await training.addToQueue('alpha');
    const preview = await training.generateTrainingPlan();
    await training.addToQueue('beta');
    const original = await readFile(configPath, 'utf8');
    await assert.rejects(training.applyPlanToTasks(preview), error => error.statusCode === 409);
    await assert.rejects(training.applyPlanToTasks({ stages: [] }), error => error.statusCode === 409);
    assert.equal(await readFile(configPath, 'utf8'), original);
  });

  it('retains applied fallback settings through synchronization and clears them with an empty queue', async () => {
    await training.addToQueue('alpha');
    await training.applyPlanToTasks(await training.generateTrainingPlan(), { fallbackStage: 'LS-6', fallbackTimes: 3 });
    await training.addToQueue('beta');
    assert.ok((await smartStages()).some(stage => stage.stage === 'LS-6' && stage.times === '3'));
    await training.removeFromQueue('alpha');
    await training.removeFromQueue('beta');
    assert.deepEqual((await smartStages()), []);
    await training.addToQueue('beta', { position: 0 });
    assert.ok((await smartStages()).some(stage => stage.stage === 'LS-6' && stage.times === '3'));
  });

  it('does not recreate a removed applied task during automatic retry', async () => {
    await training.addToQueue('alpha');
    await training.applyPlanToTasks(await training.generateTrainingPlan());
    await writeJson(configPath, { name: '日常材料筹备', taskFlow: [] });
    assert.equal((await training.getTrainingQueue()).flowSync.status, 'failed');
    const result = await training.syncTrainingFlow();
    assert.equal(result.flowSync.status, 'failed');
    assert.deepEqual((await readConfig()).taskFlow, []);
    // Explicit application can restore the task and establishes the new binding.
    await training.applyPlanToTasks(await training.generateTrainingPlan());
    assert.equal((await training.getTrainingQueue()).flowSync.status, 'synced');
  });

  it('applies to the same existing smart task that the queue advertises', async () => {
    const config = await readConfig();
    config.taskFlow.push({
      id: 'fight-training', commandId: 'fight', name: '养成专用作战',
      params: { stages: [{ stage: 'old-stage', times: '1', smart: true }] }
    });
    await writeJson(configPath, config);
    assert.equal((await training.getTrainingQueue()).flowSync.taskName, '养成专用作战');
    await training.addToQueue('alpha');
    const result = await training.applyPlanToTasks(await training.generateTrainingPlan());
    assert.equal(result.taskName, '养成专用作战');
    const appliedConfig = await readConfig();
    assert.deepEqual(appliedConfig.taskFlow[0].params.stages, normalStages);
    assert.deepEqual(appliedConfig.taskFlow[1].params.stages[0].trainingOperators, ['夜烟']);
  });

  it('reports an exact LMD shortfall without declaring materials complete or estimating currency stages', async () => {
    const materialsPath = path.join(dataDirectory, 'operator-materials.json');
    const materialData = JSON.parse(await readFile(materialsPath, 'utf8'));
    materialData.operators.alpha.elite1.lmd = 2000;
    await writeJson(materialsPath, materialData);
    await writeJson(path.join(dataDirectory, 'depot.json'), {
      items: [{ id: 'test_alpha', count: 2 }, { id: '4001', count: 300 }]
    });
    await training.addToQueue('alpha');
    const queue = await training.getTrainingQueue();
    assert.equal(queue.queue[0].isComplete, false);
    assert.equal(queue.queue[0].lmd.stillNeeded, 1700);
    const lmdOnly = await training.generateTrainingPlan();
    assert.deepEqual(lmdOnly.stages, []);
    assert.equal(lmdOnly.totalSanity, 0);
    assert.match(lmdOnly.warnings.join(' '), /尚缺 1700 龙门币/);
    assert.match(lmdOnly.warnings.join(' '), /不包含龙门币刷取估算/);
    assert.doesNotMatch(lmdOnly.warnings.join(' '), /已集齐/);

    // Currency limitations remain visible alongside an ordinary farming plan.
    await writeJson(path.join(dataDirectory, 'depot.json'), { items: [{ id: '4001', count: 300 }] });
    const mixed = await training.generateTrainingPlan();
    assert.equal(mixed.stages.length, 1);
    assert.match(mixed.warnings.join(' '), /尚缺 1700 龙门币/);
    assert.match(mixed.warnings.join(' '), /不包含龙门币刷取估算/);
  });
});
