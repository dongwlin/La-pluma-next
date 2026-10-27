import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import router from '../agent.js';
import training from '../../services/operatorTrainingService.js';

const originalMethods = { ...training };
afterEach(() => Object.assign(training, originalMethods));

function handler(method, routePath) {
  const layer = router.stack.find(item => item.route?.path === routePath && item.route.methods?.[method]);
  assert.ok(layer, `missing ${method} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    set() { return this; },
    json(value) { this.body = value; return this; }
  };
}

describe('training queue route contract', () => {
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
