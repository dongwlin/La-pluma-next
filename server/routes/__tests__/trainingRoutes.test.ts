import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import router from '../agent.ts';
import training from '../../services/operatorTrainingService.ts';
import type { OperatorTrainingService } from '../../services/operatorTrainingService.ts';
import { DEFAULT_TRAINING_SETTINGS } from '../../services/operatorTrainingModel.ts';
import type {
  TrainingCandidate,
  TrainingOperatorFilters
} from '../../services/operatorTrainingModel.ts';
import type { TrainingPlan } from '../../services/operatorTrainingPlan.ts';
import type {
  ApplyPlanResult,
  FlowSyncState,
  QueueMutationResult
} from '../../services/operatorTrainingApplication.ts';
import type { TrainingQueueItem } from '../../services/operatorTrainingStore.ts';

const originalMethods: OperatorTrainingService = { ...training };
afterEach(() => Object.assign(training, originalMethods));

function candidate(overrides: Partial<TrainingCandidate> = {}): TrainingCandidate {
  return {
    id: 'alpha',
    name: 'Alpha',
    rarity: 5,
    profession: 'CASTER',
    currentElite: 0,
    currentLevel: 1,
    targetElite: 2,
    owned: true,
    potential: 1,
    hasMaterialData: true,
    materials: null,
    canTrain: true,
    disabledReason: null,
    trainingStatus: 'trainable',
    ...overrides
  };
}

function plan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    queueRevision: 'revision-1',
    mode: 'current',
    operators: [],
    materialHierarchy: [],
    stages: [],
    totalSanity: 0,
    warnings: [],
    ...overrides
  };
}

function syncedFlow(): FlowSyncState {
  return { status: 'synced', flowName: '自动任务', taskName: '理智作战' };
}

function mutation(overrides: Partial<QueueMutationResult> = {}): QueueMutationResult {
  return { queueUpdated: true, queueRevision: 'revision-1', flowSync: syncedFlow(), ...overrides };
}

function appliedPlan(overrides: Partial<ApplyPlanResult> = {}): ApplyPlanResult {
  return {
    success: true,
    stageCount: 2,
    totalStages: 2,
    hasFallback: false,
    flowName: '自动任务',
    taskName: '理智作战',
    flowSync: syncedFlow(),
    scheduleSync: { attempted: false, success: true, message: null },
    ...overrides
  };
}

function queueItem(overrides: Partial<TrainingQueueItem> = {}): TrainingQueueItem {
  return {
    operatorId: 'alpha',
    currentElite: 1,
    targetElite: 2,
    priority: 1,
    status: 'pending',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

/** 路由层只暴露调度函数；测试取最后一个 handler 直接调用。 */
type RouteHandler = (req: unknown, res: unknown, next?: (error?: unknown) => void) => unknown;

interface MountedRoute {
  path: string;
  methods?: Record<string, boolean>;
  stack: Array<{ handle: RouteHandler }>;
}

/** Express router 本身是带 `.stack` 的函数，反射时按对象读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isMountedRoute(value: unknown): value is MountedRoute {
  if (!isRecord(value)) return false;
  if (typeof value.path !== 'string') return false;
  if (value.methods !== undefined && !isRecord(value.methods)) return false;
  if (!Array.isArray(value.stack)) return false;
  return value.stack.every(entry => isRecord(entry) && typeof entry.handle === 'function');
}

function handler(method: string, routePath: string): RouteHandler {
  const route = findMountedRoute(router, method, routePath);
  assert.ok(route, `missing ${method} ${routePath}`);
  const handle = route.stack.at(-1)?.handle;
  assert.ok(handle, `missing ${method} ${routePath} handler`);
  return handle;
}

// 养成入口由独立子 router 承担：按 agent.ts 的实际挂载关系递归解析，
// 证明这些路径仍通过聚合 router 暴露，而不是只存在于某个文件里。
function findMountedRoute(candidateRouter: unknown, method: string, routePath: string): MountedRoute | null {
  if (!isRecord(candidateRouter) || !Array.isArray(candidateRouter.stack)) return null;
  for (const layer of candidateRouter.stack) {
    if (!isRecord(layer)) continue;
    if (isMountedRoute(layer.route)
      && layer.route.path === routePath
      && layer.route.methods?.[method]) {
      return layer.route;
    }
    const nested = findMountedRoute(layer.handle, method, routePath);
    if (nested) return nested;
  }
  return null;
}

interface TestEnvelope {
  success: boolean;
  message: string;
  data: Record<string, any>;
  error?: { code?: string; message?: string };
  meta?: unknown;
}

/** 错误出口转发的是原始错误对象；只读取公开的 statusCode、code 与 message。 */
function statusCodeOf(error: unknown): unknown {
  return isRecord(error) && 'statusCode' in error ? error.statusCode : undefined;
}

function codeOf(error: unknown): unknown {
  return isRecord(error) && 'code' in error ? error.code : undefined;
}

function messageOf(error: unknown): unknown {
  return isRecord(error) && 'message' in error ? error.message : undefined;
}

interface TestResponse {
  statusCode: number;
  body?: TestEnvelope;
  status(value: number): TestResponse;
  set(): TestResponse;
  json(value: TestEnvelope): TestResponse;
}

function response(): TestResponse {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    set() { return this; },
    json(value) { this.body = value; return this; }
  };
}

function collectMountedRoutes(candidateRouter: unknown, routes: string[] = []): string[] {
  if (!isRecord(candidateRouter) || !Array.isArray(candidateRouter.stack)) return routes;
  for (const layer of candidateRouter.stack) {
    if (!isRecord(layer)) continue;
    if (isMountedRoute(layer.route)) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    collectMountedRoutes(layer.handle, routes);
  }
  return routes;
}

describe('training route exposure', () => {
  it('mounts every training entry exactly once through the agent router', () => {
    const expected = [
      'GET /training/operators',
      'GET /training/queue',
      'POST /training/queue',
      'DELETE /training/queue/:operatorId',
      'PUT /training/queue/order',
      'POST /training/sync',
      'PUT /training/settings',
      'POST /training/plan',
      'POST /actions/apply-training-plan',
      'POST /actions/fetch-training-materials'
    ];
    const mounted = collectMountedRoutes(router);

    for (const route of expected) {
      assert.equal(
        mounted.filter(candidateRoute => candidateRoute === route).length,
        1,
        `expected exactly one mounted ${route}`
      );
    }
  });
});

describe('training queue route contract', () => {
  it('keeps candidate filter normalization and plan mode pass-through', async () => {
    let filters: TrainingOperatorFilters | undefined;
    let mode: string | undefined;
    training.getOperatorList = async value => {
      filters = value;
      return [candidate()];
    };
    training.generateTrainingPlan = async value => {
      mode = value;
      return plan({ mode: value === 'all' ? 'all' : 'current' });
    };

    const operatorsRes = response();
    await handler('get', '/training/operators')({
      headers: {},
      query: { rarity: '5', profession: 'CASTER', owned: 'false', needsElite2: 'true', status: 'owned' }
    }, operatorsRes);

    assert.deepEqual(filters, {
      rarity: 5, profession: 'CASTER', owned: false, needsElite2: true, status: 'owned'
    });
    assert.deepEqual(operatorsRes.body?.data, { operators: [candidate()], count: 1 });

    const planRes = response();
    await handler('post', '/training/plan')({ headers: {}, body: { mode: 'all' } }, planRes);
    assert.equal(mode, 'all');
    assert.equal(planRes.body?.data.mode, 'all');

    await handler('post', '/training/plan')({ headers: {}, body: {} }, response());
    assert.equal(mode, 'current');
  });

  it('normalizes omitted and malformed candidate filters without changing the domain policy', async () => {
    let filters: TrainingOperatorFilters | undefined;
    training.getOperatorList = async value => {
      filters = value;
      return [];
    };

    await handler('get', '/training/operators')({ headers: {}, query: {} }, response());
    assert.deepEqual(filters, {
      rarity: undefined,
      profession: undefined,
      owned: undefined,
      needsElite2: false,
      status: 'trainable'
    });

    await handler('get', '/training/operators')({
      headers: {},
      query: { rarity: '5abc', profession: ['CASTER', 'SNIPER'], owned: 'yes', status: 'unexpected' }
    }, response());
    assert.deepEqual(filters, {
      rarity: 5,
      profession: undefined,
      owned: undefined,
      needsElite2: false,
      status: 'all'
    });

    await handler('get', '/training/operators')({
      headers: {},
      query: { rarity: 'abc', owned: 'true', needsElite2: 'false', status: 'all' }
    }, response());
    assert.deepEqual(filters, {
      rarity: undefined,
      profession: undefined,
      owned: true,
      needsElite2: false,
      status: 'all'
    });
  });

  it('rejects malformed queue bodies and invalid plan modes before mutating the queue', async () => {
    let addCalls = 0;
    training.addToQueue = async () => {
      addCalls += 1;
      return { ...queueItem(), ...mutation() };
    };
    training.generateTrainingPlan = async () => {
      addCalls += 1;
      return plan();
    };
    const forwarded: unknown[] = [];

    const missingId = response();
    await handler('post', '/training/queue')({ headers: {}, body: {} }, missingId, error => forwarded.push(error));
    assert.equal(codeOf(forwarded[0]), 'AGENT_VALIDATION_OPERATOR_ID_REQUIRED');

    const numericId = response();
    await handler('post', '/training/queue')({ headers: {}, body: { operatorId: 42 } }, numericId, error => forwarded.push(error));
    assert.equal(codeOf(forwarded[1]), 'AGENT_VALIDATION_OPERATOR_ID_REQUIRED');

    const stringPosition = response();
    await handler('post', '/training/queue')({ headers: {}, body: { operatorId: 'alpha', position: '0' } }, stringPosition, error => forwarded.push(error));
    assert.equal(messageOf(forwarded[2]), 'position 必须是有效的队列位置');

    const badOrder = response();
    await handler('put', '/training/queue/order')({ headers: {}, body: { operatorIds: 'alpha' } }, badOrder, error => forwarded.push(error));
    assert.equal(codeOf(forwarded[3]), 'AGENT_VALIDATION_OPERATOR_IDS_REQUIRED');

    const badMode = response();
    await handler('post', '/training/plan')({ headers: {}, body: { mode: 'hourly' } }, badMode, error => forwarded.push(error));
    assert.equal(messageOf(forwarded[4]), '计划模式必须为 current 或 all');

    for (const res of [missingId, numericId, stringPosition, badOrder, badMode]) {
      assert.equal(res.body, undefined);
    }
    for (const error of forwarded) {
      assert.equal(statusCodeOf(error), 400);
    }
    assert.equal(addCalls, 0);
    assert.equal(forwarded.length, 5);
  });

  it('passes an undo position and returns queue success separately from flow failure', async () => {
    let received: unknown[] | undefined;
    training.addToQueue = async (...args) => {
      received = args;
      return {
        ...queueItem(),
        queueUpdated: true,
        queueRevision: 'revision-2',
        flowSync: { status: 'failed', flowName: '自动任务', taskName: '材料作战', error: '磁盘写入失败' }
      };
    };
    const res = response();
    await handler('post', '/training/queue')({ headers: {}, body: { operatorId: 'alpha', currentElite: 1, targetElite: 2, position: 0 } }, res);
    assert.deepEqual(received, ['alpha', { currentElite: 1, targetElite: 2, position: 0 }]);
    assert.equal(res.body?.success, true);
    assert.equal(res.body?.data.queueUpdated, true);
    assert.equal(res.body?.data.flowSync.status, 'failed');
  });

  it('returns synchronization results for removal, order changes and retry', async () => {
    const result = mutation({ queueRevision: 'revision-3' });
    training.removeFromQueue = async id => { assert.equal(id, 'alpha'); return result; };
    training.updateQueueOrder = async ids => { assert.deepEqual(ids, ['beta', 'alpha']); return result; };
    training.syncTrainingFlow = async () => ({ ...result, queueUpdated: false });
    for (const [method, routePath, req] of [
      ['delete', '/training/queue/:operatorId', { params: { operatorId: 'alpha' } }],
      ['put', '/training/queue/order', { body: { operatorIds: ['beta', 'alpha'] } }],
      ['post', '/training/sync', {}]
    ] as const) {
      const res = response();
      await handler(method, routePath)({ headers: {}, ...req }, res);
      assert.equal(res.body?.data.flowSync.status, 'synced');
      assert.equal(res.body?.data.queueRevision, 'revision-3');
      assert.equal(res.body?.data.queueUpdated, method !== 'post');
    }
  });

  it('returns the applied flow and schedule refresh result together', async () => {
    let received: { plan: unknown; settings: unknown } | undefined;
    training.applyPlanToTasks = async (planBody, settings) => {
      received = { plan: planBody, settings };
      return appliedPlan({
        flowSync: syncedFlow(),
        scheduleSync: { attempted: true, success: false, message: '定时任务设置失败' }
      });
    };
    const res = response();
    await handler('post', '/actions/apply-training-plan')({
      headers: {},
      body: { plan: { queueRevision: 'revision-1' }, settings: { useMedicine: 1 } }
    }, res);

    assert.deepEqual(received, {
      plan: { queueRevision: 'revision-1' },
      settings: { useMedicine: 1 }
    });
    assert.equal(res.body?.success, true);
    assert.equal(res.body?.data.stageCount, 2);
    assert.equal(res.body?.data.flowSync.status, 'synced');
    assert.deepEqual(res.body?.data.scheduleSync, {
      attempted: true,
      success: false,
      message: '定时任务设置失败'
    });
  });

  it('passes settings through so extension fields reach domain normalization', async () => {
    let received: unknown;
    training.updateSettings = async value => {
      received = value;
      return { ...DEFAULT_TRAINING_SETTINGS, extraField: { nested: true } };
    };
    const res = response();
    await handler('put', '/training/settings')({
      headers: {},
      body: { autoSwitch: 'yes', extraField: { nested: true } }
    }, res);

    assert.deepEqual(received, { autoSwitch: 'yes', extraField: { nested: true } });
    assert.deepEqual(res.body?.data.extraField, { nested: true });
  });

  it('delegates stale preview conflicts to the unified error exit via next(error)', async () => {
    training.applyPlanToTasks = async () => { throw Object.assign(new Error('请重新生成计划'), { statusCode: 409 }); };
    const res = response();
    const forwarded: unknown[] = [];
    await handler('post', '/actions/apply-training-plan')(
      { headers: {}, body: { plan: { queueRevision: 'old' } } },
      res,
      error => forwarded.push(error)
    );

    assert.equal(forwarded.length, 1);
    assert.equal(statusCodeOf(forwarded[0]), 409);
    assert.equal(forwarded[0] instanceof Error ? forwarded[0].message : '', '请重新生成计划');
    assert.equal(res.body, undefined);
  });
});
