import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConfigStorageResult } from '../configStorageService.ts';
import type { TrainingPlan, TrainingPlanOperator, TrainingPlanStage } from '../operatorTrainingPlan.ts';
import operatorTrainingService from '../operatorTrainingService.ts';
import {
  updateSmartTrainingStages
} from '../scheduleSmartTrainingService.ts';
import type { SmartTrainingLogger } from '../scheduleSmartTrainingService.ts';

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  data?: unknown;
}

function createLogger(): { logger: SmartTrainingLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry['level']) => (message: string, data?: unknown) => {
    entries.push({ level, message, data });
    return entries.length;
  };
  return {
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      success: record('success')
    },
    entries
  };
}

function success<T>(data: T): ConfigStorageResult<T> {
  return { success: true, message: 'ok', data, meta: { requestId: null, dryRun: false } };
}

function failure(): ConfigStorageResult<never> {
  return {
    success: false,
    message: '读取失败',
    error: { code: 'CONFIG_READ_FAILED', details: {}, retryable: false },
    meta: { requestId: null, dryRun: false }
  };
}

function makeStage(name: string, totalTimes: number, isOpen = true): TrainingPlanStage {
  return {
    stage: name,
    stageId: null,
    apCost: 0,
    sanityPerRun: 0,
    dataSource: 'experience',
    materials: [],
    totalTimes,
    sanity: 0,
    isOpen
  };
}

function makeOperator(name: string): TrainingPlanOperator {
  return { id: name.toLowerCase(), name, currentElite: 0, targetElite: 1, materials: [] };
}

function makePlan(
  stages: TrainingPlanStage[],
  operators: TrainingPlanOperator[] = [],
  openStages?: TrainingPlanStage[]
): TrainingPlan {
  return {
    queueRevision: 'rev-1',
    mode: 'current',
    operators,
    materialHierarchy: [],
    stages,
    openStages,
    closedStages: [],
    focusOperator: null,
    totalSanity: 0,
    warnings: [],
    dropDataInfo: null,
    summary: {
      backlogCount: 0,
      openStageCount: stages.length,
      closedStageCount: 0,
      gameDate: '2026-01-01',
      clientType: 'Official',
      todayOpenResourceStages: [],
      todayClosedResourceStages: []
    }
  };
}

interface TasksConfig {
  taskFlow: Array<{ id: string; name: string; commandId?: string; params: { stages?: unknown[] } }>;
  schedule: { enabled: boolean; times: string[] };
}

function tasksConfig(stages: unknown[] = [{ stage: '1-7', smart: true }]): TasksConfig {
  return {
    taskFlow: [{ id: 'fight-1', name: '刷关', commandId: 'fight', params: { stages } }],
    schedule: { enabled: true, times: ['08:00'] }
  };
}

interface SavedConfig {
  type: string;
  data: unknown;
}

interface SavedTasks {
  taskFlow: Array<{ params: { stages?: unknown[] } }>;
  schedule?: unknown;
}

interface SavedQueue {
  queue: Array<Record<string, unknown>>;
  settings?: unknown;
}

function savedTasks(saved: readonly SavedConfig[]): SavedTasks | undefined {
  const entry = saved.find(item => item.type === 'automation-tasks');
  return entry ? entry.data as SavedTasks : undefined;
}

function savedQueue(saved: readonly SavedConfig[]): SavedQueue | undefined {
  const entry = saved.find(item => item.type === 'training-queue');
  return entry ? entry.data as SavedQueue : undefined;
}

describe('updateSmartTrainingStages', () => {
  it('propagates a write failure instead of reporting the flow as updated', async () => {
    const { logger, entries } = createLogger();
    const saved: SavedConfig[] = [];

    await assert.rejects(
      updateSmartTrainingStages('default', {
        loadConfig: async type => success(type === 'automation-tasks' ? tasksConfig() : { queue: [{ operatorId: 'a' }], settings: {} }),
        saveConfig: async type => {
          saved.push({ type, data: null });
          throw new Error('disk full');
        },
        generateTrainingPlan: async () => makePlan([makeStage('CE-5', 3)]),
        runtimeLogger: logger
      }),
      /disk full/
    );

    assert.deepEqual(saved.map(item => item.type), ['automation-tasks']);
    const failures = entries.filter(entry => entry.level === 'error');
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /智能养成动态更新失败/);
  });

  it('skips without writing when the task flow has no smart training stage', async () => {
    const { logger, entries } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async () => success({ taskFlow: [{ id: 'fight-1', name: '刷关', commandId: 'fight', params: { stages: ['1-7'] } }] }),
      saveConfig: async type => {
        saved.push({ type, data: null });
        return success(null);
      },
      generateTrainingPlan: async () => {
        throw new Error('plan generation must not run');
      },
      runtimeLogger: logger
    });

    assert.deepEqual(saved, []);
    assert.match(entries.map(entry => entry.message).join('\n'), /未找到智能养成关卡/);
  });

  it('treats an unreadable automation-tasks config as absent and keeps the stored file', async () => {
    const { logger, entries } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async () => failure(),
      saveConfig: async type => {
        saved.push({ type, data: null });
        return success(null);
      },
      generateTrainingPlan: async () => makePlan([makeStage('CE-5', 3)]),
      runtimeLogger: logger
    });

    assert.deepEqual(saved, []);
    assert.match(entries.map(entry => entry.message).join('\n'), /未找到任务流程配置/);
  });

  it('clears every smart stage when the training queue is empty', async () => {
    const { logger } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks' ? tasksConfig() : { queue: [], settings: {} }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => {
        throw new Error('plan generation must not run');
      },
      runtimeLogger: logger
    });

    assert.deepEqual(saved.map(item => item.type), ['automation-tasks']);
    const tasks = savedTasks(saved);
    assert.deepEqual(tasks?.taskFlow[0].params.stages, [{ stage: '', times: '' }]);
    assert.deepEqual(tasks?.schedule, { enabled: true, times: ['08:00'] });
  });

  it('warns and keeps the flow when plan generation returns no stage list', async () => {
    const { logger, entries } = createLogger();
    const saved: SavedConfig[] = [];
    const incomplete = makePlan([]);
    Reflect.deleteProperty(incomplete, 'stages');

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks' ? tasksConfig() : { queue: [{ operatorId: 'a' }], settings: {} }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => incomplete,
      runtimeLogger: logger
    });

    assert.deepEqual(saved, []);
    assert.match(entries.map(entry => entry.message).join('\n'), /生成刷取计划失败/);
  });

  it('switches to the next operator and writes the regenerated smart stages', async () => {
    const { logger } = createLogger();
    const saved: SavedConfig[] = [];
    let planCalls = 0;

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks'
        ? tasksConfig([{ stage: '1-7', smart: true }, { stage: 'LS-5', pinned: true }, 'CE-6'])
        : { queue: [{ operatorId: 'a', name: 'Alpha' }, { operatorId: 'b', name: 'Beta' }], settings: { autoSwitch: true } }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => {
        planCalls += 1;
        return planCalls === 1
          ? makePlan([], [makeOperator('Alpha')])
          : makePlan([makeStage('CE-5', 5)], [makeOperator('Beta')]);
      },
      runtimeLogger: logger
    });

    assert.deepEqual(saved.map(item => item.type), ['training-queue', 'automation-tasks']);
    assert.deepEqual(savedQueue(saved)?.queue.map(operator => operator.operatorId), ['b']);
    assert.deepEqual(savedTasks(saved)?.taskFlow[0].params.stages, [
      { stage: 'LS-5', pinned: true },
      { stage: 'CE-5', times: '5', smart: true, trainingOperators: ['Beta'] },
      'CE-6'
    ]);
  });

  it('clears the smart stages instead of switching when autoSwitch is disabled', async () => {
    const { logger } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks'
        ? tasksConfig([{ stage: '1-7', smart: true }, 'CE-6'])
        : { queue: [{ operatorId: 'a' }, { operatorId: 'b' }], settings: { autoSwitch: false } }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => makePlan([]),
      runtimeLogger: logger
    });

    assert.deepEqual(saved.map(item => item.type), ['automation-tasks']);
    assert.deepEqual(savedTasks(saved)?.taskFlow[0].params.stages, ['CE-6']);
  });

  it('clears smart stages when today has no open stage for the plan', async () => {
    const { logger } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks'
        ? tasksConfig([{ stage: '1-7', smart: true }])
        : { queue: [{ operatorId: 'a' }], settings: {} }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => makePlan([makeStage('1-7', 0, false)]),
      runtimeLogger: logger
    });

    assert.deepEqual(saved.map(item => item.type), ['automation-tasks']);
    assert.deepEqual(savedTasks(saved)?.taskFlow[0].params.stages, [{ stage: '', times: '' }]);
  });

  it('rewrites the remaining stages when the plan still has open stages', async () => {
    const { logger } = createLogger();
    const saved: SavedConfig[] = [];

    await updateSmartTrainingStages('default', {
      loadConfig: async type => success(type === 'automation-tasks'
        ? tasksConfig([{ stage: '1-7', smart: true }, 'CE-6'])
        : { queue: [{ operatorId: 'a' }], settings: {} }),
      saveConfig: async (type, data) => {
        saved.push({ type, data });
        return success(null);
      },
      generateTrainingPlan: async () => makePlan([makeStage('CE-5', 4)], [makeOperator('Alpha')]),
      runtimeLogger: logger
    });

    assert.deepEqual(savedTasks(saved)?.taskFlow[0].params.stages, [
      { stage: 'CE-5', times: '4', smart: true, trainingOperators: ['Alpha'] },
      'CE-6'
    ]);
  });

  it('generates the plan for the connection client type', async () => {
    const { logger } = createLogger();
    const captured: Array<{ mode?: string; options?: { clientType?: string } }> = [];
    const original = operatorTrainingService.generateTrainingPlan;
    operatorTrainingService.generateTrainingPlan = async (mode, options) => {
      captured.push({ mode, options });
      return makePlan([makeStage('CE-5', 3)]);
    };

    try {
      await updateSmartTrainingStages('default', {
        loadConfig: async type => success(type === 'automation-tasks'
          ? tasksConfig([{ stage: '1-7', smart: true }])
          : { queue: [{ operatorId: 'a' }], settings: {} }),
        saveConfig: async () => success(null),
        resolveClientType: async () => 'YoStarJP',
        runtimeLogger: logger
      });
    } finally {
      operatorTrainingService.generateTrainingPlan = original;
    }

    assert.deepEqual(captured, [{ mode: 'current', options: { clientType: 'YoStarJP' } }]);
  });
});
