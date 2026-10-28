import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../server.js'
import operatorTraining from '../services/operatorTrainingService.ts'

const servers = []
const originalMethods = {
  getOperatorList: operatorTraining.getOperatorList,
  getTrainingQueue: operatorTraining.getTrainingQueue,
  addToQueue: operatorTraining.addToQueue,
  removeFromQueue: operatorTraining.removeFromQueue,
  updateQueueOrder: operatorTraining.updateQueueOrder,
  updateSettings: operatorTraining.updateSettings,
  syncTrainingFlow: operatorTraining.syncTrainingFlow,
  generateTrainingPlan: operatorTraining.generateTrainingPlan,
  applyPlanToTasks: operatorTraining.applyPlanToTasks,
  fetchOperatorMaterials: operatorTraining.fetchOperatorMaterials
}
const originalConsoleError = console.error

async function listen(app) {
  const server = createServer(app)
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function agentUrl(port, path) {
  return `http://127.0.0.1:${port}/api/agent${path}`
}

function stubService(names, calls) {
  for (const name of names) {
    operatorTraining[name] = async () => {
      calls.count += 1
      return {}
    }
  }
}

afterEach(async () => {
  Object.assign(operatorTraining, originalMethods)
  console.error = originalConsoleError
  while (servers.length) {
    const server = servers.pop()
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

describe('training routes over real HTTP', () => {
  it('requires the API token on every training entry before reaching the service', async () => {
    const app = createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      loginRateLimit: { maxAuthFailures: 100 }
    })
    const port = await listen(app)
    const calls = { count: 0 }
    stubService(Object.keys(originalMethods), calls)

    const entries = [
      ['GET', '/training/operators'],
      ['GET', '/training/queue'],
      ['POST', '/training/queue'],
      ['DELETE', '/training/queue/alpha'],
      ['PUT', '/training/queue/order'],
      ['POST', '/training/sync'],
      ['PUT', '/training/settings'],
      ['POST', '/training/plan'],
      ['POST', '/actions/apply-training-plan'],
      ['POST', '/actions/fetch-training-materials']
    ]

    for (const [method, path] of entries) {
      const response = await fetch(agentUrl(port, path), { method })
      assert.equal(response.status, 401, `${method} ${path} must stay behind auth`)
      assert.equal((await response.json()).error.code, 'AGENT_AUTH_REQUIRED')
    }
    assert.equal(calls.count, 0)

    operatorTraining.getTrainingQueue = async () => ({ queue: [], revision: 'revision-1' })
    const authorized = await fetch(agentUrl(port, '/training/queue'), {
      headers: { Authorization: 'Bearer api-secret' }
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).data.revision, 'revision-1')
  })

  it('rejects invalid training write bodies before calling the service', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const calls = { count: 0 }
    stubService(['addToQueue', 'updateQueueOrder', 'applyPlanToTasks'], calls)

    const cases = [
      ['POST', '/training/queue', {}, 'AGENT_VALIDATION_OPERATOR_ID_REQUIRED'],
      ['PUT', '/training/queue/order', { operatorIds: 'alpha' }, 'AGENT_VALIDATION_OPERATOR_IDS_REQUIRED'],
      ['POST', '/actions/apply-training-plan', { settings: { useMedicine: 1 } }, 'AGENT_VALIDATION_PLAN_REQUIRED']
    ]

    for (const [method, path, body, code] of cases) {
      const response = await fetch(agentUrl(port, path), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      assert.equal(response.status, 400, `${method} ${path}`)
      const payload = await response.json()
      assert.equal(payload.success, false)
      assert.equal(payload.error.code, code)
    }
    assert.equal(calls.count, 0)
  })

  it('keeps a saved queue distinguishable from failed flow and schedule synchronization', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const flowSync = { status: 'failed', flowName: '自动任务', taskName: '材料作战', error: '磁盘写入失败' }

    operatorTraining.addToQueue = async () => ({
      operatorId: 'alpha', queueUpdated: true, queueRevision: 'revision-2', flowSync
    })
    operatorTraining.syncTrainingFlow = async () => ({
      queueUpdated: false, queueRevision: 'revision-2', flowSync
    })
    operatorTraining.applyPlanToTasks = async () => ({
      success: true,
      stageCount: 1,
      flowName: '自动任务',
      taskName: '理智作战',
      flowSync: { status: 'synced', flowName: '自动任务' },
      scheduleSync: { attempted: true, success: false, message: '定时任务设置失败' }
    })

    const added = await fetch(agentUrl(port, '/training/queue'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'alpha', currentElite: 1, targetElite: 2, position: 0 })
    })
    assert.equal(added.status, 200)
    const addedBody = await added.json()
    assert.equal(addedBody.success, true)
    assert.equal(addedBody.data.queueUpdated, true)
    assert.equal(addedBody.data.queueRevision, 'revision-2')
    assert.equal(addedBody.data.flowSync.status, 'failed')

    const synced = await fetch(agentUrl(port, '/training/sync'), { method: 'POST' })
    assert.equal(synced.status, 200)
    const syncedBody = await synced.json()
    assert.equal(syncedBody.message, '任务流程同步失败，可重试')
    assert.equal(syncedBody.data.flowSync.status, 'failed')

    const applied = await fetch(agentUrl(port, '/actions/apply-training-plan'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: { queueRevision: 'revision-2' } })
    })
    assert.equal(applied.status, 200)
    const appliedBody = await applied.json()
    assert.equal(appliedBody.success, true)
    assert.equal(appliedBody.data.flowSync.status, 'synced')
    assert.deepEqual(appliedBody.data.scheduleSync, {
      attempted: true,
      success: false,
      message: '定时任务设置失败'
    })
  })

  it('routes training service errors through the unified error exit', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    operatorTraining.getTrainingQueue = async () => {
      throw new Error('内部堆栈泄露标记')
    }
    console.error = () => {}

    const response = await fetch(agentUrl(port, '/training/queue'))

    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.success, false)
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR')
    assert.equal(body.message, '服务器内部错误')
    assert.ok(!JSON.stringify(body).includes('内部堆栈泄露标记'))
  })
})
