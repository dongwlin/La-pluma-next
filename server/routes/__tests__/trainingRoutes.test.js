import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import router from '../agent.js';
import training from '../../services/operatorTrainingService.ts';

const originalMethods = { ...training };
afterEach(() => Object.assign(training, originalMethods));

function handler(method, routePath) {
  const route = findMountedRoute(router, method, routePath);
  assert.ok(route, `missing ${method} ${routePath}`);
  return route.stack.at(-1).handle;
}

// 养成入口由独立子 router 承担：按 agent.js 的实际挂载关系递归解析，
// 证明这些路径仍通过聚合 router 暴露，而不是只存在于某个文件里。
function findMountedRoute(routerInstance, method, routePath) {
  for (const layer of routerInstance.stack) {
    if (layer.route?.path === routePath && layer.route.methods?.[method]) return layer.route;
    if (layer.handle?.stack) {
      const nested = findMountedRoute(layer.handle, method, routePath);
      if (nested) return nested;
    }
  }
  return null;
}

function response() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    set() { return this; },
    json(value) { this.body = value; return this; }
  };
}

function collectMountedRoutes(routerInstance, routes = []) {
  for (const layer of routerInstance.stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    if (layer.handle?.stack) collectMountedRoutes(layer.handle, routes);
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
        mounted.filter(candidate => candidate === route).length,
        1,
        `expected exactly one mounted ${route}`
      );
    }
  });
});

describe('training queue route contract', () => {
  it('keeps candidate filter normalization and plan mode pass-through', async () => {
    let filters
    let mode
    training.getOperatorList = async value => {
      filters = value
      return [{ id: 'alpha' }]
    }
    training.generateTrainingPlan = async value => {
      mode = value
      return { mode: value }
    }

    const operatorsRes = response()
    await handler('get', '/training/operators')({
      headers: {},
      query: { rarity: '5', profession: 'CASTER', owned: 'false', needsElite2: 'true', status: 'owned' }
    }, operatorsRes)

    assert.deepEqual(filters, {
      rarity: 5, profession: 'CASTER', owned: false, needsElite2: true, status: 'owned'
    })
    assert.deepEqual(operatorsRes.body.data, { operators: [{ id: 'alpha' }], count: 1 })

    const planRes = response()
    await handler('post', '/training/plan')({ headers: {}, body: { mode: 'all' } }, planRes)
    assert.equal(mode, 'all')
    assert.deepEqual(planRes.body.data, { mode: 'all' })

    await handler('post', '/training/plan')({ headers: {}, body: {} }, response())
    assert.equal(mode, 'current')
  })

  it('passes an undo position and returns queue success separately from flow failure', async () => {
    let received;
    training.addToQueue = async (...args) => {
      received = args;
      return {
        operatorId: 'alpha', queueUpdated: true, queueRevision: 'revision-2',
        flowSync: { status: 'failed', flowName: '自动任务', taskName: '材料作战', error: '磁盘写入失败' }
      };
    };
    const res = response();
    await handler('post', '/training/queue')({ headers: {}, body: { operatorId: 'alpha', currentElite: 1, targetElite: 2, position: 0 } }, res);
    assert.deepEqual(received, ['alpha', { currentElite: 1, targetElite: 2, position: 0 }]);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.queueUpdated, true);
    assert.equal(res.body.data.flowSync.status, 'failed');
  });

  it('returns synchronization results for removal, order changes and retry', async () => {
    const result = { queueUpdated: true, queueRevision: 'revision-3', flowSync: { status: 'synced', flowName: '自动任务' } };
    training.removeFromQueue = async id => { assert.equal(id, 'alpha'); return result; };
    training.updateQueueOrder = async ids => { assert.deepEqual(ids, ['beta', 'alpha']); return result; };
    training.syncTrainingFlow = async () => ({ ...result, queueUpdated: false });
    for (const [method, routePath, req] of [
      ['delete', '/training/queue/:operatorId', { params: { operatorId: 'alpha' } }],
      ['put', '/training/queue/order', { body: { operatorIds: ['beta', 'alpha'] } }],
      ['post', '/training/sync', {}]
    ]) {
      const res = response();
      await handler(method, routePath)({ headers: {}, ...req }, res);
      assert.equal(res.body.data.flowSync.status, 'synced');
      assert.equal(res.body.data.queueRevision, 'revision-3');
      assert.equal(res.body.data.queueUpdated, method !== 'post');
    }
  });

  it('returns the applied flow and schedule refresh result together', async () => {
    let received;
    training.applyPlanToTasks = async (plan, settings) => {
      received = { plan, settings };
      return {
        success: true,
        stageCount: 2,
        flowName: '自动任务',
        taskName: '理智作战',
        flowSync: { status: 'synced', flowName: '自动任务' },
        scheduleSync: { attempted: true, success: false, message: '定时任务设置失败' }
      };
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
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.stageCount, 2);
    assert.equal(res.body.data.flowSync.status, 'synced');
    assert.deepEqual(res.body.data.scheduleSync, {
      attempted: true,
      success: false,
      message: '定时任务设置失败'
    });
  });

  it('delegates stale preview conflicts to the unified error exit via next(error)', async () => {
    training.applyPlanToTasks = async () => { throw Object.assign(new Error('请重新生成计划'), { statusCode: 409 }); };
    const res = response();
    const forwarded = [];
    await handler('post', '/actions/apply-training-plan')(
      { headers: {}, body: { plan: { queueRevision: 'old' } } },
      res,
      error => forwarded.push(error)
    );

    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].statusCode, 409);
    assert.equal(forwarded[0].message, '请重新生成计划');
    assert.equal(res.body, undefined);
  });
});
