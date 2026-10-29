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
  FlowSyncState,
  QueueMutationResult
} from '../../services/operatorTrainingApplication.ts';

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
  data: unknown;
  error?: { code?: string; message?: string };
  meta?: unknown;
}

/** 端点结果按用例声明的字段读取；未声明的字段保持 unknown。 */
function dataOf<T>(envelope: TestEnvelope | undefined): T {
  assert.ok(envelope, 'missing response envelope');
  return envelope.data as T;
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
    assert.equal(dataOf<{ mode: string }>(planRes.body).mode, 'all');

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
      const payload = dataOf<{
        flowSync: FlowSyncState;
        queueRevision: string;
        queueUpdated: boolean;
      }>(res.body);
      assert.equal(payload.flowSync.status, 'synced');
      assert.equal(payload.queueRevision, 'revision-3');
      assert.equal(payload.queueUpdated, method !== 'post');
    }
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
    assert.deepEqual(dataOf<{ extraField: unknown }>(res.body).extraField, { nested: true });
  });
});
