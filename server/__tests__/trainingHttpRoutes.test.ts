import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../server.js'
import operatorTraining from '../services/operatorTrainingService.ts'
import type {
  OperatorTrainingService,
  TrainingQueueSnapshot
} from '../services/operatorTrainingService.ts'
import { DEFAULT_TRAINING_SETTINGS } from '../services/operatorTrainingModel.ts'
import type { ApplyPlanResult, FlowSyncState } from '../services/operatorTrainingApplication.ts'
import type { TrainingQueueItem } from '../services/operatorTrainingStore.ts'

const servers: Server[] = []
const originalMethods: OperatorTrainingService = { ...operatorTraining }
const originalConsoleError = console.error

async function listen(app: ReturnType<typeof createLaPlumaApp>): Promise<number> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

function agentUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}/api/agent${path}`
}

interface ApiEnvelope {
  success: boolean
  message: string
  data?: Record<string, any>
  error?: { code?: string }
}

function isApiEnvelope(value: unknown): value is ApiEnvelope {
  return typeof value === 'object'
    && value !== null
    && 'success' in value
    && 'message' in value
}

/** fetch 的 JSON 载荷是 unknown；测试只读取统一成功/错误信封。 */
async function readEnvelope(response: Response): Promise<ApiEnvelope> {
  const body: unknown = await response.json()
  assert.ok(isApiEnvelope(body))
  return body
}

/**
 * 认证与坏请求用例必须在到达服务前结束：任何未显式替换的养成方法
 * 被调用即抛错并计数，避免以“返回空对象”掩盖路由提前放行。
 */
function stubUnreachableService(calls: { count: number }): void {
  const unreachable = async (): Promise<never> => {
    calls.count += 1
    throw new Error('training service must not be reached')
  }
  Object.assign(operatorTraining, {
    getOperatorList: unreachable,
    getTrainingQueue: unreachable,
    addToQueue: unreachable,
    removeFromQueue: unreachable,
    updateQueueOrder: unreachable,
    updateSettings: unreachable,
    syncTrainingFlow: unreachable,
    generateTrainingPlan: unreachable,
    applyPlanToTasks: unreachable,
    fetchOperatorMaterials: unreachable
  } satisfies Partial<OperatorTrainingService>)
}

function emptyQueueSnapshot(overrides: Partial<TrainingQueueSnapshot> = {}): TrainingQueueSnapshot {
  return {
    queue: [],
    settings: { ...DEFAULT_TRAINING_SETTINGS },
    lastUpdated: '2026-01-01T00:00:00.000Z',
    revision: 'revision-1',
    flowSync: { status: 'not_applied', flowName: '自动任务', taskName: '理智作战' },
    ...overrides
  }
}

function syncedFlow(): FlowSyncState {
  return { status: 'synced', flowName: '自动任务', taskName: '理智作战' };
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
  }
}

function appliedPlan(overrides: Partial<ApplyPlanResult> = {}): ApplyPlanResult {
  return {
    success: true,
    stageCount: 1,
    totalStages: 1,
    hasFallback: false,
    flowName: '自动任务',
    taskName: '理智作战',
    flowSync: syncedFlow(),
    scheduleSync: { attempted: false, success: true, message: null },
    ...overrides
  }
}

afterEach(async () => {
  Object.assign(operatorTraining, originalMethods)
  console.error = originalConsoleError
  while (servers.length) {
    const server = servers.pop()
    server?.closeIdleConnections()
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
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
    stubUnreachableService(calls)

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
    ] as const

    for (const [method, path] of entries) {
      const response = await fetch(agentUrl(port, path), { method })
      assert.equal(response.status, 401, `${method} ${path} must stay behind auth`)
      assert.equal((await readEnvelope(response)).error?.code, 'AGENT_AUTH_REQUIRED')
    }
    assert.equal(calls.count, 0)

    operatorTraining.getTrainingQueue = async () => emptyQueueSnapshot()
    const authorized = await fetch(agentUrl(port, '/training/queue'), {
      headers: { Authorization: 'Bearer api-secret' }
    })
    assert.equal(authorized.status, 200)
    assert.equal((await readEnvelope(authorized)).data?.revision, 'revision-1')
  })

  it('rejects invalid training write bodies before calling the service', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const calls = { count: 0 }
    stubUnreachableService(calls)

    const cases = [
      ['POST', '/training/queue', {}, 400, 'AGENT_VALIDATION_OPERATOR_ID_REQUIRED', '缺少 operatorId 参数'],
      ['POST', '/training/queue', { operatorId: 42 }, 400, 'AGENT_VALIDATION_OPERATOR_ID_REQUIRED', '缺少 operatorId 参数'],
      ['POST', '/training/queue', { operatorId: 'alpha', position: '0' }, 400, 'AGENT_INTERNAL_ERROR', 'position 必须是有效的队列位置'],
      ['PUT', '/training/queue/order', { operatorIds: 'alpha' }, 400, 'AGENT_VALIDATION_OPERATOR_IDS_REQUIRED', 'operatorIds 必须是数组'],
      ['POST', '/actions/apply-training-plan', { settings: { useMedicine: 1 } }, 400, 'AGENT_VALIDATION_PLAN_REQUIRED', '缺少 plan 参数'],
      ['POST', '/training/plan', { mode: 'hourly' }, 400, 'AGENT_INTERNAL_ERROR', '计划模式必须为 current 或 all']
    ] as const

    for (const [method, path, body, status, code, message] of cases) {
      const response = await fetch(agentUrl(port, path), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      assert.equal(response.status, status, `${method} ${path}`)
      const payload = await readEnvelope(response)
      assert.equal(payload.success, false)
      assert.equal(payload.error?.code, code)
      assert.equal(payload.message, message)
    }
    assert.equal(calls.count, 0)
  })

  it('keeps a saved queue distinguishable from failed flow and schedule synchronization', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const flowSync: FlowSyncState = { status: 'failed', flowName: '自动任务', taskName: '材料作战', error: '磁盘写入失败' }

    operatorTraining.addToQueue = async () => ({
      ...queueItem(),
      queueUpdated: true,
      queueRevision: 'revision-2',
      flowSync
    })
    operatorTraining.syncTrainingFlow = async () => ({
      queueUpdated: false, queueRevision: 'revision-2', flowSync
    })
    operatorTraining.applyPlanToTasks = async () => appliedPlan({
      scheduleSync: { attempted: true, success: false, message: '定时任务设置失败' }
    })

    const added = await fetch(agentUrl(port, '/training/queue'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'alpha', currentElite: 1, targetElite: 2, position: 0 })
    })
    assert.equal(added.status, 200)
    const addedBody = await readEnvelope(added)
    assert.equal(addedBody.success, true)
    assert.equal(addedBody.data?.queueUpdated, true)
    assert.equal(addedBody.data?.queueRevision, 'revision-2')
    assert.equal(addedBody.data?.flowSync.status, 'failed')

    const synced = await fetch(agentUrl(port, '/training/sync'), { method: 'POST' })
    assert.equal(synced.status, 200)
    const syncedBody = await readEnvelope(synced)
    assert.equal(syncedBody.message, '任务流程同步失败，可重试')
    assert.equal(syncedBody.data?.flowSync.status, 'failed')

    const applied = await fetch(agentUrl(port, '/actions/apply-training-plan'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: { queueRevision: 'revision-2' } })
    })
    assert.equal(applied.status, 200)
    const appliedBody = await readEnvelope(applied)
    assert.equal(appliedBody.success, true)
    assert.equal(appliedBody.data?.flowSync.status, 'synced')
    assert.deepEqual(appliedBody.data?.scheduleSync, {
      attempted: true,
      success: false,
      message: '定时任务设置失败'
    })
  })

  it('returns candidate projections and their count from the domain service', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    let filters: unknown
    operatorTraining.getOperatorList = async value => {
      filters = value
      return [
        {
          id: 'alpha', name: 'Alpha', rarity: 5, profession: 'CASTER',
          currentElite: 0, currentLevel: 1, targetElite: 2, owned: true, potential: 1,
          hasMaterialData: true, materials: null, canTrain: true, disabledReason: null,
          trainingStatus: 'trainable'
        },
        {
          id: 'beta', name: 'Beta', rarity: 4, profession: 'SNIPER',
          currentElite: 0, currentLevel: 1, targetElite: 2, owned: false, potential: 0,
          hasMaterialData: true, materials: null, canTrain: false, disabledReason: 'unowned',
          trainingStatus: 'unowned'
        }
      ]
    }

    const response = await fetch(agentUrl(port, '/training/operators?rarity=5&status=owned'), {
      headers: { 'content-type': 'application/json' }
    })
    assert.equal(response.status, 200)
    const payload = await readEnvelope(response)
    assert.deepEqual(filters, {
      rarity: 5,
      profession: undefined,
      owned: undefined,
      needsElite2: false,
      status: 'owned'
    })
    assert.equal(payload.data?.count, 2)
    assert.deepEqual(payload.data?.operators.map((operator: { id: string }) => operator.id), ['alpha', 'beta'])
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
    const body = await readEnvelope(response)
    assert.equal(body.success, false)
    assert.equal(body.error?.code, 'AGENT_INTERNAL_ERROR')
    assert.equal(body.message, '服务器内部错误')
    assert.ok(!JSON.stringify(body).includes('内部堆栈泄露标记'))
  })
})
