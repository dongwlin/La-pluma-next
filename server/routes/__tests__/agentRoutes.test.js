import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import router, { executeTrackedAgentAction } from '../agent.js'
import { API_VERSION } from '../agentContract.js'
import { getTaskStatus, setTaskStatus } from '../../services/maaService.js'
import { loggerManager } from '../../utils/logger.ts'
import {
  beginAgentRun,
  completeAgentRun,
  flushAgentRunStore,
  getAgentRun,
  getCurrentAgentRun,
  initializeAgentRunStore,
  listAgentRuns,
  resetAgentRunsForTests,
  shutdownAgentRunStoreForTests,
  startAgentRun
} from '../../services/agentRunService.js'
import {
  getScheduleExecutionStatus,
  stopScheduleExecution
} from '../../services/schedulerService.js'
import {
  configureCopilotSetRuntimeForTests,
  resetCopilotSetRunStateForTests
} from '../../services/copilotSetRunService.js'
import {
  getMaaExecutionLeaseSnapshot,
  withMaaExecutionLease
} from '../../services/executionCoordinatorService.js'
import { getTodayOpenStages } from '../../services/notificationService.js'

const quietLogger = {
  info() {},
  error() {}
}

let lockDir
let lockFile
let previousLockFile

before(async () => {
  lockDir = await mkdtemp(join(tmpdir(), 'la-pluma-agent-routes-'))
  lockFile = join(lockDir, 'maa-execution.lock')
  previousLockFile = process.env.LA_PLUMA_MAA_LOCK_FILE
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockFile
})

after(async () => {
  if (previousLockFile === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE
  else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLockFile
  await rm(lockDir, { recursive: true, force: true })
})

// 路由存在性以 agent.js 实际挂载的 router 图为准：执行路由由独立子 router
// 承担，这里按挂载关系递归解析，不依赖某个文件里的声明位置。
function collectMountedRoutes(routerInstance, routes = []) {
  for (const layer of routerInstance.stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`)
      }
      continue
    }
    if (layer.handle?.stack) collectMountedRoutes(layer.handle, routes)
  }
  return routes
}

function findMountedRoute(routerInstance, method, path) {
  for (const layer of routerInstance.stack) {
    if (layer.route?.path === path && layer.route.methods?.[method]) return layer.route
    if (layer.handle?.stack) {
      const nested = findMountedRoute(layer.handle, method, path)
      if (nested) return nested
    }
  }
  return null
}

function findHandler(method, path) {
  const route = findMountedRoute(router, method, path)
  assert.ok(route, `missing ${method.toUpperCase()} ${path}`)
  return route.stack.at(-1).handle
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

describe('Agent discovery routes', () => {
  it('serves the generated manifest through the public route', async () => {
    const res = createResponse()
    await findHandler('get', '/manifest')({ headers: { 'x-request-id': 'manifest-test' } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.meta.requestId, 'manifest-test')
    assert.equal(res.body.data.version, API_VERSION)
    assert.equal(res.body.data.actions.length, 21)
    assert.ok(res.body.data.actions.every(action => action.safety && action.execution))
  })

  it('serves OpenAPI with real query parameters and structured errors', async () => {
    const res = createResponse()
    await findHandler('get', '/openapi.json')({ headers: {} }, res)

    const discover = res.body.paths['/api/agent/actions/discover-devices'].get
    assert.equal(res.body.openapi, '3.1.0')
    assert.equal(discover.requestBody, undefined)
    assert.ok(discover.parameters.some(parameter => parameter.name === 'adbPath' && parameter.in === 'query'))
    assert.equal(
      res.body.components.responses.Conflict.content['application/json'].schema.$ref,
      '#/components/schemas/ErrorResponse'
    )
  })

  it('exposes every execution route exactly once through the mounted agent router', () => {
    const executionRoutes = [
      'POST /activity/run',
      'POST /copilot-sets/:id/execute',
      'POST /actions/continue-copilot-set',
      'POST /schedules/:scheduleId/execute',
      'POST /actions/start-game',
      'POST /actions/run-daily-flow',
      'POST /actions/fight',
      'POST /actions/run-task',
      'POST /actions/stop'
    ]
    const mounted = collectMountedRoutes(router)

    for (const route of executionRoutes) {
      assert.equal(
        mounted.filter(candidate => candidate === route).length,
        1,
        `expected exactly one mounted ${route}`
      )
    }
  })
})

describe('Agent run routes', () => {
  beforeEach(() => resetAgentRunsForTests())
  afterEach(() => {
    resetAgentRunsForTests()
    if (getTaskStatus().isRunning) setTaskStatus(false)
  })

  it('returns a retained terminal snapshot by run id', async () => {
    const run = beginAgentRun({ operationId: 'fight', input: { stage: '1-7' } }).run
    startAgentRun(run.runId)
    completeAgentRun(run.runId, { success: true, summary: 'done' })
    const res = createResponse()

    await findHandler('get', '/runs/:runId')({
      headers: { 'x-request-id': 'run-lookup' },
      params: { runId: run.runId }
    }, res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.meta.requestId, 'run-lookup')
    assert.equal(res.body.data.runId, run.runId)
    assert.equal(res.body.data.state, 'succeeded')
    assert.deepEqual(res.body.data.result, { success: true, summary: 'done' })
  })

  it('returns a structured 404 for an unknown run id', async () => {
    const res = createResponse()

    await findHandler('get', '/runs/:runId')({
      headers: {},
      params: { runId: '00000000-0000-4000-8000-000000000000' }
    }, res, () => {})

    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'AGENT_RUN_NOT_FOUND')
  })

  it('keeps the legacy current-run fields while exposing the tracked run', async () => {
    const terminal = beginAgentRun({ operationId: 'fight' }).run
    completeAgentRun(terminal.runId, { ok: true })
    const run = beginAgentRun({ operationId: 'run_task' }).run
    startAgentRun(run.runId)
    const res = createResponse()

    await findHandler('get', '/runs/current')({ headers: {}, query: { lines: 1 } }, res, () => {})

    assert.equal(typeof res.body.data.isRunning, 'boolean')
    assert.ok(res.body.data.schedule)
    assert.ok(Array.isArray(res.body.data.recentLogs))
    assert.equal(res.body.data.run.runId, run.runId)
    assert.equal(res.body.data.run.state, 'running')
    assert.equal(res.body.data.lastRun.runId, terminal.runId)
    assert.equal(res.body.data.lastRun.state, 'succeeded')
  })

  it('selects lastRun by completion time rather than creation order', async () => {
    const originalNow = Date.now
    let now = Date.parse('2026-07-12T00:00:00.000Z')
    Date.now = () => now
    try {
      const older = beginAgentRun({ operationId: 'fight' }).run
      now += 1
      const newer = beginAgentRun({ operationId: 'run_task' }).run
      now += 1
      completeAgentRun(newer.runId, { order: 1 })
      now += 1
      completeAgentRun(older.runId, { order: 2 })
      const res = createResponse()

      await findHandler('get', '/runs/current')({ headers: {}, query: {} }, res, () => {})

      assert.equal(res.body.data.lastRun.runId, older.runId)
      assert.deepEqual(res.body.data.lastRun.result, { order: 2 })
    } finally {
      Date.now = originalNow
    }
  })

  it('replays one background intent without executing it twice and retains its final result', async () => {
    const req = { headers: { 'idempotency-key': 'background:test:1' } }
    const first = createResponse()
    let executions = 0
    let settle = null
    const options = {
      operationId: 'test_background_action',
      input: { command: 'award', waitForCompletion: false },
      waitForCompletion: false,
      execute: async lifecycle => {
        executions += 1
        settle = lifecycle.onSettled
        return { message: 'started', plan: { command: 'award' } }
      }
    }

    await executeTrackedAgentAction(req, first, options)

    assert.equal(first.statusCode, 202)
    assert.equal(first.headers['Idempotency-Replayed'], 'false')
    assert.equal(executions, 1)
    const runId = first.body.data.runId

    const activeReplay = createResponse()
    await executeTrackedAgentAction(req, activeReplay, options)
    assert.equal(activeReplay.statusCode, 202)
    assert.equal(activeReplay.body.data.message, first.body.data.message)
    assert.deepEqual(activeReplay.body.data.plan, first.body.data.plan)
    assert.equal(activeReplay.body.data.runId, runId)
    assert.equal(executions, 1)

    await settle({ ok: true, result: { stdout: 'finished', exitCode: 0 } })
    const terminal = getAgentRun(runId)
    assert.equal(terminal.state, 'succeeded')
    assert.deepEqual(terminal.result, {
      message: 'started',
      plan: { command: 'award' },
      stdout: 'finished',
      exitCode: 0
    })

    const replay = createResponse()
    await executeTrackedAgentAction(req, replay, options)

    assert.equal(replay.statusCode, 200)
    assert.equal(replay.headers['Idempotency-Replayed'], 'true')
    assert.equal(replay.body.data.runId, runId)
    assert.equal(replay.body.data.run.state, 'succeeded')
    assert.equal(executions, 1)
  })

  it('returns an early background failure instead of a successful accepted response', async () => {
    const error = new Error('background process failed before admission returned')
    error.code = 'EARLY_BACKGROUND_FAILURE'
    error.statusCode = 422
    const res = createResponse()

    await executeTrackedAgentAction(
      { headers: { 'idempotency-key': 'background:early-failure' } },
      res,
      {
        operationId: 'test_early_background_failure',
        input: { command: 'award' },
        waitForCompletion: false,
        execute: async lifecycle => {
          lifecycle.onStarted()
          await lifecycle.onSettled({ ok: false, error })
          return { message: 'started' }
        }
      }
    )

    assert.equal(res.statusCode, 422)
    assert.equal(res.body.success, false)
    assert.equal(res.body.error.code, 'EARLY_BACKGROUND_FAILURE')
    assert.equal(res.body.error.details.run.state, 'failed')
  })

  it('returns a stopped result when a background process exits during admission', async () => {
    const res = createResponse()

    await executeTrackedAgentAction(
      { headers: { 'idempotency-key': 'background:early-stop' } },
      res,
      {
        operationId: 'test_early_background_stop',
        input: { command: 'fight' },
        waitForCompletion: false,
        execute: async lifecycle => {
          lifecycle.onStarted()
          await lifecycle.onSettled({
            ok: false,
            stopped: true,
            result: { signal: 'SIGTERM' }
          })
          return { message: 'started' }
        }
      }
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.message, '任务已终止')
    assert.equal(res.body.data.run.state, 'stopped')
    assert.equal(res.body.data.signal, 'SIGTERM')
  })

  it('does not execute when the accepted run cannot be persisted and releases the key for retry', async () => {
    let failWrites = false
    let executions = 0
    const req = { headers: { 'idempotency-key': 'persistence:retry:1' } }
    const options = {
      operationId: 'test_persistence_failure',
      input: { command: 'award' },
      execute: async () => {
        executions += 1
        return { success: true }
      }
    }
    const routeLogger = loggerManager.getLogger('AgentRoutes')
    const wasConsoleEnabled = routeLogger.enableConsole
    routeLogger.enableConsole = false

    try {
      await initializeAgentRunStore({
        filePath: '/virtual/agent-route-runs.json',
        readStore: async (_filePath, fallback) => fallback,
        writeStore: async () => {
          if (failWrites) throw new Error('simulated write failure')
        },
        runtimeLogger: quietLogger
      })

      failWrites = true
      const rejected = createResponse()
      await executeTrackedAgentAction(req, rejected, options)

      assert.equal(rejected.statusCode, 503)
      assert.equal(rejected.body.error.code, 'AGENT_RUN_PERSISTENCE_FAILED')
      assert.equal(executions, 0)
      const rejectedRunId = rejected.body.error.details.runId

      failWrites = false
      const retry = createResponse()
      await executeTrackedAgentAction(req, retry, options)

      assert.equal(retry.statusCode, 200)
      assert.equal(executions, 1)
      assert.notEqual(retry.body.data.runId, rejectedRunId)
    } finally {
      failWrites = false
      try {
        await shutdownAgentRunStoreForTests()
      } finally {
        routeLogger.enableConsole = wasConsoleEnabled
      }
    }
  })

  it('replays a run interrupted by restart without executing it again', async () => {
    let snapshot = null
    let executions = 0
    const req = { headers: { 'idempotency-key': 'restart:interrupted:1' } }
    const options = {
      operationId: 'test_restart_interruption',
      input: { command: 'fight' },
      execute: async () => {
        executions += 1
        return { success: true }
      }
    }
    const store = {
      filePath: '/virtual/agent-route-restart-runs.json',
      runtimeLogger: quietLogger,
      writeStore: async (_filePath, value) => {
        snapshot = JSON.parse(JSON.stringify(value))
      }
    }

    await initializeAgentRunStore({ ...store, readStore: async (_filePath, fallback) => fallback })

    try {
      const accepted = beginAgentRun({
        operationId: options.operationId,
        idempotencyKey: req.headers['idempotency-key'],
        input: options.input
      }).run
      await flushAgentRunStore()
      await shutdownAgentRunStoreForTests()
      await initializeAgentRunStore({ ...store, readStore: async () => snapshot })

      const replay = createResponse()
      await executeTrackedAgentAction(req, replay, options)

      assert.equal(replay.statusCode, 503)
      assert.equal(replay.headers['Idempotency-Replayed'], 'true')
      assert.equal(replay.body.error.code, 'AGENT_RUN_INTERRUPTED')
      assert.equal(replay.body.error.retryable, false)
      assert.equal(replay.body.error.details.runId, accepted.runId)
      assert.equal(executions, 0)
    } finally {
      await shutdownAgentRunStoreForTests()
    }
  })

  it('waits for the accepted snapshot before acknowledging a concurrent replay', async () => {
    let blockWrites = false
    let releaseBlockedWrite
    let signalWriteStarted
    const writeStarted = new Promise(resolve => { signalWriteStarted = resolve })
    let executions = 0
    const req = { headers: { 'idempotency-key': 'persistence:concurrent:1' } }
    const options = {
      operationId: 'test_persistence_concurrency',
      input: { command: 'award' },
      execute: async () => {
        executions += 1
        return { success: true }
      }
    }

    await initializeAgentRunStore({
      filePath: '/virtual/agent-route-concurrent-runs.json',
      readStore: async (_filePath, fallback) => fallback,
      writeStore: async () => {
        if (!blockWrites) return
        signalWriteStarted()
        await new Promise(resolve => { releaseBlockedWrite = resolve })
      },
      runtimeLogger: quietLogger
    })

    try {
      blockWrites = true
      const first = createResponse()
      let firstFinished = false
      const firstRequest = executeTrackedAgentAction(req, first, options)
        .then(() => { firstFinished = true })
      await writeStarted

      const replay = createResponse()
      let replayFinished = false
      const replayRequest = executeTrackedAgentAction(req, replay, options)
        .then(() => { replayFinished = true })
      await new Promise(resolve => setImmediate(resolve))

      assert.equal(firstFinished, false)
      assert.equal(replayFinished, false)
      assert.equal(executions, 0)

      blockWrites = false
      releaseBlockedWrite()
      await Promise.all([firstRequest, replayRequest])

      assert.equal(first.statusCode, 200)
      assert.equal(replay.statusCode, 202)
      assert.equal(replay.headers['Idempotency-Replayed'], 'true')
      assert.equal(replay.body.data.runId, first.body.data.runId)
      assert.equal(executions, 1)
    } finally {
      blockWrites = false
      releaseBlockedWrite?.()
      await shutdownAgentRunStoreForTests()
    }
  })

  it('refreshes a replay that becomes terminal while its state is being persisted', async () => {
    let blockWrites = false
    let releaseBlockedWrite
    let signalWriteStarted
    const writeStarted = new Promise(resolve => { signalWriteStarted = resolve })
    let executions = 0
    const req = { headers: { 'idempotency-key': 'persistence:refresh-replay' } }
    const options = {
      operationId: 'test_replay_refresh',
      input: { command: 'award' },
      waitForCompletion: false,
      execute: async () => {
        executions += 1
        return { message: 'must not execute' }
      }
    }

    await initializeAgentRunStore({
      filePath: '/virtual/agent-route-refresh-runs.json',
      readStore: async (_filePath, fallback) => fallback,
      writeStore: async () => {
        if (!blockWrites) return
        signalWriteStarted()
        await new Promise(resolve => { releaseBlockedWrite = resolve })
      },
      runtimeLogger: quietLogger
    })

    try {
      const run = beginAgentRun({
        operationId: options.operationId,
        idempotencyKey: req.headers['idempotency-key'],
        input: options.input
      }).run
      await flushAgentRunStore()

      blockWrites = true
      startAgentRun(run.runId)
      const replay = createResponse()
      const replayRequest = executeTrackedAgentAction(req, replay, options)
      await writeStarted
      completeAgentRun(run.runId, { stdout: 'finished during replay' })
      blockWrites = false
      releaseBlockedWrite()
      await replayRequest

      assert.equal(replay.statusCode, 200)
      assert.equal(replay.headers['Idempotency-Replayed'], 'true')
      assert.equal(replay.body.data.run.state, 'succeeded')
      assert.equal(replay.body.data.stdout, 'finished during replay')
      assert.equal(executions, 0)
    } finally {
      blockWrites = false
      releaseBlockedWrite?.()
      await shutdownAgentRunStoreForTests()
    }
  })

  it('serializes a replay from the same snapshot observed at response time', async () => {
    const req = { headers: { 'idempotency-key': 'persistence:response-snapshot' } }
    const input = { command: 'award' }
    const run = beginAgentRun({
      operationId: 'test_response_snapshot',
      idempotencyKey: req.headers['idempotency-key'],
      input
    }).run
    startAgentRun(run.runId)

    let executions = 0
    let stateAtSerialization = null
    const res = createResponse()
    const serialize = res.json
    res.json = function json(body) {
      stateAtSerialization = getAgentRun(run.runId).state
      return serialize.call(this, body)
    }

    const replay = executeTrackedAgentAction(req, res, {
      operationId: 'test_response_snapshot',
      input,
      waitForCompletion: false,
      execute: async () => {
        executions += 1
        return { message: 'must not execute' }
      }
    })
    queueMicrotask(() => completeAgentRun(run.runId, { stdout: 'completed in microtask' }))
    await replay

    assert.equal(res.body.data.run.state, stateAtSerialization)
    assert.equal(getAgentRun(run.runId).state, 'succeeded')
    assert.equal(executions, 0)
  })

  it('returns a background failure that settles during the response flush', async () => {
    let releaseBlockedWrite
    let signalWriteStarted
    const writeStarted = new Promise(resolve => { signalWriteStarted = resolve })
    let settle
    const error = new Error('background failed during response persistence')
    error.code = 'BACKGROUND_SETTLED_DURING_FLUSH'
    error.statusCode = 422

    await initializeAgentRunStore({
      filePath: '/virtual/agent-route-response-runs.json',
      readStore: async (_filePath, fallback) => fallback,
      writeStore: async (_filePath, snapshot) => {
        const run = snapshot.runs[0]?.run
        if (run?.status === 'running' && run?.result?.message === 'started') {
          signalWriteStarted()
          await new Promise(resolve => { releaseBlockedWrite = resolve })
        }
      },
      runtimeLogger: quietLogger
    })

    try {
      const res = createResponse()
      const request = executeTrackedAgentAction(
        { headers: { 'idempotency-key': 'background:settle-during-flush' } },
        res,
        {
          operationId: 'test_settle_during_response_flush',
          input: { command: 'award' },
          waitForCompletion: false,
          execute: async lifecycle => {
            lifecycle.onStarted()
            settle = lifecycle.onSettled
            return { message: 'started' }
          }
        }
      )

      await writeStarted
      const settlement = settle({ ok: false, error })
      releaseBlockedWrite()
      await Promise.all([request, settlement])

      assert.equal(res.statusCode, 422)
      assert.equal(res.body.success, false)
      assert.equal(res.body.error.code, 'BACKGROUND_SETTLED_DURING_FLUSH')
      assert.equal(res.body.error.details.run.state, 'failed')
    } finally {
      releaseBlockedWrite?.()
      await shutdownAgentRunStoreForTests()
    }
  })

  it('keeps a concurrently replayed run queryable when admission later fails', async () => {
    const req = { headers: { 'idempotency-key': 'busy:retry:1' } }
    let rejectAdmission
    let executions = 0
    const options = {
      operationId: 'test_busy_action',
      input: { command: 'fight', waitForCompletion: false },
      waitForCompletion: false,
      execute: async () => {
        executions += 1
        if (executions === 1) {
          await new Promise((_, reject) => { rejectAdmission = reject })
        }
        return { message: 'started' }
      }
    }

    const first = createResponse()
    const firstRequest = executeTrackedAgentAction(req, first, options)
    await Promise.resolve()
    const replay = createResponse()
    await executeTrackedAgentAction(req, replay, options)
    const replayedRunId = replay.body.data.runId
    const busy = new Error('MAA 正在被其他任务使用')
    busy.code = 'MAA_EXECUTION_BUSY'
    busy.statusCode = 409
    busy.retryable = true
    rejectAdmission(busy)
    await firstRequest

    assert.equal(replay.statusCode, 202)
    assert.equal(first.statusCode, 409)
    assert.equal(first.body.data, undefined)
    assert.equal(first.body.error.details.runId, replayedRunId)
    assert.equal(getAgentRun(replayedRunId).state, 'failed')

    const retry = createResponse()
    await executeTrackedAgentAction(req, retry, options)
    assert.equal(retry.statusCode, 202)
    assert.notEqual(retry.body.data.runId, replayedRunId)
    assert.equal(executions, 2)
  })

  it('does not let a pending admission hide the run that owns the executor', async () => {
    const owner = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(owner.runId)
    let rejectAdmission
    const res = createResponse()
    const request = executeTrackedAgentAction(
      { headers: { 'idempotency-key': 'pending:behind-owner' } },
      res,
      {
        operationId: 'run_task',
        input: { command: 'award' },
        execute: async () => new Promise((_, reject) => { rejectAdmission = reject })
      }
    )
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(getCurrentAgentRun().runId, owner.runId)
    const busy = new Error('MAA 正在被其他任务使用')
    busy.code = 'MAA_EXECUTION_BUSY'
    busy.statusCode = 409
    rejectAdmission(busy)
    await request

    assert.equal(res.statusCode, 409)
    assert.equal(getCurrentAgentRun().runId, owner.runId)
  })

  it('rejects guarded stop when the requested run is not current', async () => {
    const older = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(older.runId)
    const current = beginAgentRun({ operationId: 'run_task' }).run
    startAgentRun(current.runId)
    const res = createResponse()

    await findHandler('post', '/actions/stop')({
      headers: {},
      body: { runId: older.runId }
    }, res, () => {})

    assert.equal(res.statusCode, 409)
    assert.equal(res.body.error.code, 'AGENT_RUN_NOT_CURRENT')
    assert.equal(res.body.error.details.requestedRunId, older.runId)
    assert.equal(res.body.error.details.currentRunId, current.runId)
  })

  it('cancels an accepted run without touching an untracked legacy process', async () => {
    const signals = []
    setTaskStatus(true, '旧版任务', 'legacy', {
      pid: null,
      exitCode: null,
      kill: signal => signals.push(signal)
    })
    let rejectAdmission
    const startResponse = createResponse()
    const startRequest = executeTrackedAgentAction(
      { headers: { 'idempotency-key': 'guard:legacy-process' } },
      startResponse,
      {
        operationId: 'run_task',
        input: { command: 'award' },
        execute: async () => new Promise((_, reject) => { rejectAdmission = reject })
      }
    )
    await Promise.resolve()
    const acceptedRun = getCurrentAgentRun()
    assert.equal(acceptedRun.state, 'accepted')

    const stopResponse = createResponse()
    await findHandler('post', '/actions/stop')({
      headers: {},
      body: { runId: acceptedRun.runId }
    }, stopResponse, () => {})

    assert.equal(stopResponse.statusCode, 200)
    assert.equal(stopResponse.body.data.acceptedRunCanceled, true)
    assert.equal(stopResponse.body.data.deviceStopRequested, false)
    assert.equal(stopResponse.body.data.run.state, 'stopped')
    assert.deepEqual(stopResponse.body.data.run.result, {
      canceled: true,
      reason: 'stop_requested_before_start'
    })
    assert.deepEqual(signals, [])

    const busy = new Error('MAA 正在被其他任务使用')
    busy.code = 'MAA_EXECUTION_BUSY'
    busy.statusCode = 409
    rejectAdmission(busy)
    await startRequest

    assert.equal(startResponse.statusCode, 200)
    assert.equal(startResponse.body.data.run.state, 'stopped')
    assert.equal(getAgentRun(acceptedRun.runId).state, 'stopped')
  })

  it('stops an accepted run between admission and execution without executing it', async () => {
    let releaseGate
    let executions = 0
    const res = createResponse()
    const request = executeTrackedAgentAction(
      { headers: { 'idempotency-key': 'cancel:before-start' } },
      res,
      {
        operationId: 'run_task',
        input: { command: 'award' },
        execute: async lifecycle => {
          await new Promise(resolve => { releaseGate = resolve })
          await lifecycle.onBeforeStart()
          executions += 1
          return { success: true }
        }
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    const acceptedRun = getCurrentAgentRun()
    assert.equal(acceptedRun.state, 'accepted')

    const stopResponse = createResponse()
    await findHandler('post', '/actions/stop')({
      headers: {},
      body: { runId: acceptedRun.runId }
    }, stopResponse, () => {})
    assert.equal(stopResponse.statusCode, 200)
    assert.equal(stopResponse.body.data.acceptedRunCanceled, true)

    releaseGate()
    await request

    assert.equal(executions, 0)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.run.state, 'stopped')
    assert.equal(res.body.data.canceled, true)
    assert.equal(getAgentRun(acceptedRun.runId).state, 'stopped')
  })

  it('does not let an old terminal run stop a newer execution', async () => {
    const signals = []
    const oldRun = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(oldRun.runId)
    completeAgentRun(oldRun.runId, { ok: true })
    const currentRun = beginAgentRun({ operationId: 'run_task' }).run
    startAgentRun(currentRun.runId)
    setTaskStatus(true, '新任务', 'agent', {
      pid: null,
      exitCode: null,
      kill: signal => signals.push(signal)
    })

    const res = createResponse()
    await findHandler('post', '/actions/stop')({
      headers: {},
      body: { runId: oldRun.runId }
    }, res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.alreadyTerminal, true)
    assert.equal(res.body.data.deviceStopRequested, false)
    assert.deepEqual(signals, [])
    assert.equal(getAgentRun(currentRun.runId).state, 'running')
  })

  it('accepts the targeted stop link through its query parameter', async () => {
    const run = beginAgentRun({ operationId: 'fight' }).run
    assert.equal(run.links.stop, `/api/agent/actions/stop?runId=${run.runId}`)

    const res = createResponse()
    await findHandler('post', '/actions/stop')({
      headers: {},
      query: { runId: run.runId }
    }, res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.acceptedRunCanceled, true)
    assert.equal(res.body.data.run.state, 'stopped')
  })

  it('keeps a targeted stop retryable while the run is stopping', async () => {
    const signals = []
    setTaskStatus(true, '理智作战', 'agent', {
      pid: null,
      exitCode: null,
      kill: signal => signals.push(signal)
    })
    const run = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(run.runId)
    const stop = findHandler('post', '/actions/stop')

    const first = createResponse()
    await stop({ headers: {}, body: { runId: run.runId } }, first, () => {})
    const second = createResponse()
    await stop({ headers: {}, body: { runId: run.runId } }, second, () => {})

    assert.equal(first.statusCode, 200)
    assert.equal(first.body.data.deviceStopRequested, true)
    assert.equal(first.body.data.run.state, 'stopping')
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.data.stopRequested, true)
    assert.equal(second.body.data.run.state, 'stopping')
    assert.deepEqual(signals, ['SIGTERM'])
  })

  it('rejects a non-string run guard instead of stopping the current execution', async () => {
    const signals = []
    setTaskStatus(true, '理智作战', 'agent', {
      pid: null,
      exitCode: null,
      kill: signal => signals.push(signal)
    })
    const run = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(run.runId)

    const res = createResponse()
    const forwarded = []
    await findHandler('post', '/actions/stop')({
      headers: {},
      body: { runId: 42 }
    }, res, error => forwarded.push(error))

    assert.equal(forwarded.length, 1)
    assert.equal(forwarded[0].statusCode, 400)
    assert.equal(forwarded[0].code, 'AGENT_VALIDATION_RUN_ID_INVALID')
    assert.equal(res.body, null)
    assert.deepEqual(signals, [])
    assert.equal(getAgentRun(run.runId).state, 'running')
  })

  it('reports external occupancy when the device is used without a tracked run', async () => {
    setTaskStatus(true, '未纳管任务', 'legacy', { pid: null, exitCode: null, kill() {} })
    const res = createResponse()

    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, res, () => {})

    assert.equal(res.body.data.run, null)
    assert.deepEqual(res.body.data.activeRuns, [])
    assert.equal(res.body.data.isRunning, true)
    assert.equal(res.body.data.occupancy.state, 'external')
    assert.equal(res.body.data.occupancy.runId, null)
    assert.ok(res.body.data.occupancy.sources.includes('task'))
  })

  it('distinguishes a pending accepted run from external device activity', async () => {
    const accepted = beginAgentRun({ operationId: 'run_task' }).run

    const free = createResponse()
    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, free, () => {})
    assert.equal(free.body.data.occupancy.state, 'pending')
    assert.equal(free.body.data.occupancy.runId, accepted.runId)
    assert.equal(free.body.data.occupancy.runState, 'accepted')

    setTaskStatus(true, '未纳管任务', 'legacy', { pid: null, exitCode: null, kill() {} })
    const busy = createResponse()
    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, busy, () => {})
    assert.equal(busy.body.data.occupancy.state, 'external')
    assert.equal(busy.body.data.occupancy.runId, accepted.runId)
  })

  it('exposes every active intent instead of hiding concurrent accepted runs', async () => {
    const older = beginAgentRun({ operationId: 'fight' }).run
    const newer = beginAgentRun({ operationId: 'run_task' }).run
    const res = createResponse()

    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, res, () => {})

    assert.deepEqual(
      res.body.data.activeRuns.map(run => run.runId),
      [newer.runId, older.runId]
    )
    assert.equal(res.body.data.run.runId, newer.runId)
    assert.equal(res.body.data.occupancy.state, 'pending')
  })

  it('reports a held lease with its owner in the occupancy snapshot', async () => {
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      source: 'copilot-set',
      taskName: '作业集',
      command: 'copilot-plan',
      startedAt: new Date().toISOString()
    }))
    const res = createResponse()
    try {
      await findHandler('get', '/runs/current')({ headers: {}, query: {} }, res, () => {})
    } finally {
      await rm(lockFile, { force: true })
    }

    assert.equal(res.body.data.occupancy.state, 'external')
    assert.equal(res.body.data.occupancy.lease.state, 'held')
    assert.equal(res.body.data.occupancy.lease.owner.pid, process.pid)
    assert.equal(res.body.data.occupancy.lease.owner.source, 'copilot-set')
    assert.ok(res.body.data.occupancy.sources.includes('lease'))
  })
})

describe('Agent daily flow route', () => {
  it('returns an inspectable dry-run plan with the standard dry-run metadata', async () => {
    const res = createResponse()
    const req = {
      headers: { 'x-request-id': 'dry-run-test' },
      body: {
        dryRun: true,
        scheduleId: 'contract-test',
        taskFlow: [
          { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true }
        ]
      },
      query: {}
    }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.meta.requestId, 'dry-run-test')
    assert.equal(res.body.meta.dryRun, true)
    assert.equal(res.body.data.dryRun, true)
    assert.equal(res.body.data.scheduleId, 'contract-test')
    assert.equal(res.body.data.totalSteps, 1)
    assert.deepEqual(res.body.data.plan[0], {
      index: 1,
      id: 'award-1',
      name: '领取奖励',
      command: 'award',
      args: [],
      dynamicTask: false
    })
  })

  it('uses scheduler-native dynamic configs and advanced fight arguments in dry-run output', async () => {
    const res = createResponse()
    const req = {
      headers: {},
      query: {},
      body: {
        dryRun: true,
        taskFlow: [{
          id: 'recruit-1', commandId: 'recruit', name: '自动公招', enabled: true,
          taskType: 'Recruit', params: { refresh: true, times: '4' }
        }, {
          id: 'fight-1', commandId: 'fight', name: '理智作战', enabled: true,
          params: {
            stage: '1-7', medicine: 1, drops: '30011=10',
            report_to_penguin: true, penguin_id: 'doctor'
          }
        }]
      }
    }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.body.meta.dryRun, true)
    assert.equal(res.body.data.plan[0].command, 'run')
    assert.equal(res.body.data.plan[0].dynamicTask, true)
    assert.equal(res.body.data.plan[0].taskConfig.type, 'Recruit')
    assert.deepEqual(res.body.data.plan[1].args, [
      '1-7', '-m', '1', '-D30011=10', '--report-to-penguin', '--penguin-id', 'doctor'
    ])
  })

  it('rejects invalid scheduler configuration during dry-run', async () => {
    const res = createResponse()
    const req = {
      headers: {},
      query: {},
      body: {
        dryRun: true,
        taskFlow: [{
          id: 'infrast-1', name: '基建换班', enabled: true,
          taskType: 'Infrast', params: { mode: 10000, filename: '' }
        }]
      }
    }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.success, false)
    assert.equal(res.body.error.code, 'AGENT_DAILY_FLOW_REJECTED')
    assert.match(res.body.message, /排班文件/)
  })

  it('returns a validation error for malformed task entries', async () => {
    const res = createResponse()
    const req = { headers: {}, query: {}, body: { dryRun: true, taskFlow: [null] } }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'AGENT_DAILY_FLOW_REJECTED')
    assert.equal(res.body.error.details.result.details.index, 0)
  })
})

async function waitForSnapshot(predicate, { timeout = 8000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error('condition not met before timeout')
}

function fastDailyFlow() {
  return [
    { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} },
    { id: 'infrast-1', commandId: 'infrast', name: '基建换班', enabled: true, params: { facility: [] } }
  ]
}

function interStepDailyFlow() {
  const closed = getTodayOpenStages().closed[0]?.stage
  assert.ok(closed, 'expected at least one closed resource stage today')
  return [
    { id: 'fight-closed-1', commandId: 'fight', name: '理智作战', enabled: true, params: { stage: closed } },
    { id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true, params: {} }
  ]
}

function scheduleExecuteRequest(body, headers = {}) {
  return {
    headers,
    params: { scheduleId: 'manual' },
    body
  }
}

describe('Agent daily flow run coverage', () => {
  beforeEach(async () => {
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
    if (getTaskStatus().isRunning) setTaskStatus(false)
  })

  afterEach(async () => {
    stopScheduleExecution()
    await waitForSnapshot(() => !getScheduleExecutionStatus().isRunning, { timeout: 3000 })
      .catch(() => {})
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
    if (getTaskStatus().isRunning) setTaskStatus(false)
  })

  it('keeps the legacy synchronous response and adds a terminal run identity', async () => {
    const res = createResponse()
    const handler = findHandler('post', '/schedules/:scheduleId/execute')

    await handler(scheduleExecuteRequest({ taskFlow: fastDailyFlow() }), res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.data.success, true)
    assert.equal(res.body.data.stopped, false)
    assert.equal(res.body.data.scheduleId, 'manual')
    assert.equal(res.body.data.totalSteps, 2)
    assert.equal(res.body.data.summary.skippedCount, 2)
    assert.ok(res.body.data.runId)
    assert.equal(res.headers['X-La-Pluma-Run-Id'], res.body.data.runId)

    const run = getAgentRun(res.body.data.runId)
    assert.equal(run.operationId, 'run_daily_flow')
    assert.equal(run.state, 'succeeded')
    assert.equal(run.result.summary.taskResults.length, 2)
    assert.equal(getScheduleExecutionStatus().runId, null)
  })

  it('accepts a background flow early and keeps progress queryable while it waits between steps', async () => {
    const flow = interStepDailyFlow()
    const res = createResponse()
    const handler = findHandler('post', '/schedules/:scheduleId/execute')

    await handler(scheduleExecuteRequest({ taskFlow: flow, waitForCompletion: false }), res, () => {})

    assert.equal(res.statusCode, 202)
    assert.equal(res.body.data.accepted, true)
    assert.equal(res.body.data.scheduleId, 'manual')
    assert.equal(res.body.data.totalSteps, 2)
    assert.ok(res.body.data.runId)
    assert.equal(res.headers.Location, `/api/agent/runs/${res.body.data.runId}`)
    const runId = res.body.data.runId

    await waitForSnapshot(() => {
      const status = getScheduleExecutionStatus()
      return status.isRunning && status.runId === runId && status.currentStep === 0
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    const waiting = getScheduleExecutionStatus()
    assert.equal(waiting.isRunning, true)
    assert.equal(waiting.runId, runId)
    assert.equal(waiting.currentTaskId, 'fight-closed-1')
    assert.equal(getTaskStatus().isRunning, false)

    const run = getAgentRun(runId)
    assert.equal(run.state, 'running')
    assert.equal(run.progress, undefined)

    const snapshotRes = createResponse()
    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, snapshotRes, () => {})

    assert.equal(snapshotRes.body.data.run.runId, runId)
    assert.equal(snapshotRes.body.data.run.state, 'running')
    assert.equal(snapshotRes.body.data.run.progress.scheduleId, 'manual')
    assert.equal(snapshotRes.body.data.run.progress.currentStep, 0)
    assert.equal(snapshotRes.body.data.run.progress.totalSteps, 2)
    assert.equal(snapshotRes.body.data.occupancy.state, 'run')
    assert.equal(snapshotRes.body.data.occupancy.schedule.runId, runId)

    const stopRes = createResponse()
    await findHandler('post', '/actions/stop')({ headers: {}, query: {}, body: { runId } }, stopRes, () => {})

    assert.equal(stopRes.statusCode, 200)
    assert.equal(stopRes.body.data.run.state, 'stopping')

    const terminal = await waitForSnapshot(() => {
      const current = getAgentRun(runId)
      return current && ['stopped', 'failed', 'succeeded'].includes(current.state) ? current : null
    })

    assert.equal(terminal.state, 'stopped')
    assert.equal(terminal.result.stopped, true)
    assert.equal(terminal.result.summary.taskResults[0].status, 'skipped')
    assert.equal(terminal.result.summary.taskResults[1].status, 'pending')
    assert.equal(getScheduleExecutionStatus().isRunning, false)
    assert.equal(getScheduleExecutionStatus().runId, null)
  })

  it('reuses one run for an idempotent resubmission and rejects a changed input', async () => {
    const headers = { 'idempotency-key': 'daily-flow:replay:1' }
    const first = createResponse()
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({ taskFlow: fastDailyFlow(), waitForCompletion: false }, headers),
      first,
      () => {}
    )

    assert.equal(first.statusCode, 202)
    const runId = first.body.data.runId

    await waitForSnapshot(() => {
      const run = getAgentRun(runId)
      return run && run.state === 'succeeded' ? run : null
    })

    const replay = createResponse()
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({ taskFlow: fastDailyFlow(), waitForCompletion: false }, headers),
      replay,
      () => {}
    )

    assert.ok([200, 202].includes(replay.statusCode))
    assert.equal(replay.body.data.runId, runId)
    assert.equal(replay.headers['Idempotency-Replayed'], 'true')
    assert.equal(listAgentRuns({ operationId: 'run_daily_flow' }).length, 1)

    const conflict = createResponse()
    const forwardedConflicts = []
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({
        taskFlow: [{ id: 'award-2', commandId: 'award', name: '另一条流程', enabled: true, params: {} }]
      }, headers),
      conflict,
      error => forwardedConflicts.push(error)
    )

    assert.equal(forwardedConflicts.length, 1)
    assert.equal(forwardedConflicts[0].statusCode, 409)
    assert.equal(forwardedConflicts[0].code, 'AGENT_IDEMPOTENCY_KEY_REUSED')
  })

  it('maps an occupied executor to the legacy code and releases the idempotency key', async () => {
    const headers = { 'idempotency-key': 'daily-flow:busy:1' }
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      source: 'test-owner',
      taskName: '占用设备',
      command: 'copilot',
      startedAt: new Date().toISOString()
    }))

    const busy = createResponse()
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({ taskFlow: fastDailyFlow() }, headers),
      busy,
      () => {}
    )

    assert.equal(busy.statusCode, 409)
    assert.equal(busy.body.error.code, 'AGENT_SCHEDULE_ALREADY_RUNNING')
    assert.equal(busy.body.error.retryable, true)
    const rejectedRun = getAgentRun(busy.body.error.details.runId)
    assert.equal(rejectedRun.state, 'failed')
    assert.equal(rejectedRun.error.code, 'AGENT_SCHEDULE_ALREADY_RUNNING')
    assert.equal(getScheduleExecutionStatus().isRunning, false)

    await rm(lockFile, { force: true })
    const retry = createResponse()
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({ taskFlow: fastDailyFlow() }, headers),
      retry,
      () => {}
    )

    assert.equal(retry.statusCode, 200)
    assert.notEqual(retry.body.data.runId, rejectedRun.runId)
    assert.equal(getAgentRun(retry.body.data.runId).state, 'succeeded')
  })

  it('accepts the Agent daily-flow entry early and serves the final result by run id', async () => {
    const res = createResponse()
    const req = {
      headers: { 'idempotency-key': 'daily-flow:agent:1' },
      query: {},
      body: {
        dryRun: false,
        scheduleId: 'agent-daily-flow',
        taskFlow: fastDailyFlow(),
        waitForCompletion: false
      }
    }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.statusCode, 202)
    assert.equal(res.body.data.accepted, true)
    assert.equal(res.body.data.totalSteps, 2)
    assert.equal(res.body.data.plan.length, 2)
    const runId = res.body.data.runId

    const terminal = await waitForSnapshot(() => {
      const run = getAgentRun(runId)
      return run && run.state === 'succeeded' ? run : null
    })

    assert.equal(terminal.result.success, true)
    assert.equal(terminal.result.plan[0].command, 'award')

    const lookup = createResponse()
    await findHandler('get', '/runs/:runId')({ headers: {}, params: { runId } }, lookup, () => {})

    assert.equal(lookup.statusCode, 200)
    assert.equal(lookup.body.data.runId, runId)
    assert.equal(lookup.body.data.state, 'succeeded')
    assert.equal(lookup.body.data.result.summary.taskResults.length, 2)
  })

  it('does not create a run for a dry-run plan', async () => {
    const res = createResponse()
    const req = {
      headers: {},
      query: {},
      body: { dryRun: true, scheduleId: 'dry-run', taskFlow: fastDailyFlow() }
    }

    await findHandler('post', '/actions/run-daily-flow')(req, res, () => {})

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.meta.dryRun, true)
    assert.deepEqual(listAgentRuns(), [])
  })
})

describe('Agent daily flow concurrency', () => {
  beforeEach(async () => {
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
  })

  afterEach(async () => {
    stopScheduleExecution()
    await waitForSnapshot(() => !getScheduleExecutionStatus().isRunning, { timeout: 3000 })
      .catch(() => {})
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
  })

  it('rejects a second daily flow instead of sharing one execution lease', async () => {
    const first = createResponse()
    await findHandler('post', '/schedules/:scheduleId/execute')(
      scheduleExecuteRequest({ taskFlow: interStepDailyFlow(), waitForCompletion: false }),
      first,
      () => {}
    )

    assert.equal(first.statusCode, 202)
    const runId = first.body.data.runId
    assert.equal(getAgentRun(runId).state, 'running')

    const second = createResponse()
    await findHandler('post', '/actions/run-daily-flow')({
      headers: {},
      query: {},
      body: { dryRun: false, scheduleId: 'agent-daily-flow', taskFlow: fastDailyFlow() }
    }, second, () => {})

    assert.equal(second.statusCode, 409)
    assert.equal(second.body.error.code, 'AGENT_EXECUTION_BUSY')
    assert.equal(second.body.error.retryable, true)
    assert.equal(getAgentRun(runId).state, 'running')
    assert.equal(getScheduleExecutionStatus().runId, runId)

    const stopRes = createResponse()
    await findHandler('post', '/actions/stop')({ headers: {}, query: {}, body: { runId } }, stopRes, () => {})
    assert.equal(stopRes.statusCode, 200)

    const terminal = await waitForSnapshot(() => {
      const run = getAgentRun(runId)
      return run && run.state === 'stopped' ? run : null
    })
    assert.equal(terminal.state, 'stopped')
  })
})

function copilotSetPlan(count = 2) {
  return {
    setId: '42',
    name: '测试作业集',
    entries: Array.from({ length: count }, (_, index) => ({
      key: `${index}:${100 + index}:normal`,
      itemIndex: index,
      copilotId: 100 + index,
      stageId: `main_01-0${index + 1}`,
      displayStage: `1-${index + 1}`,
      apCost: 6,
      mode: 'normal',
      presetFormation: false,
      completed: false
    }))
  }
}

function createCopilotSetExecutor(plan, { onExecute = null } = {}) {
  const executed = []
  return {
    executed,
    async execute({ entries, lifecycle }) {
      const statusByKey = new Map(entries.map(entry => [entry.key, 'pending']))
      let stopped = false
      await withMaaExecutionLease({ source: 'copilot-set', taskName: '测试作业集', command: 'copilot-plan' }, async () => {
        await lifecycle.onBeforeStart?.()
        lifecycle.onStarted?.()
        for (const entry of entries) {
          if (await lifecycle.shouldStop?.()) {
            stopped = true
            break
          }
          lifecycle.onEntryStarted?.(entry, [entry])
          executed.push(entry.key)
          await onExecute?.(entry)
          statusByKey.set(entry.key, 'success')
          lifecycle.onEntrySettled?.(entry, 'success')
        }
      })
      const taskResults = plan.entries
        .filter(entry => statusByKey.has(entry.key))
        .map(entry => ({
          key: entry.key,
          itemIndex: entry.itemIndex,
          copilotId: entry.copilotId,
          stageId: entry.stageId,
          stage: entry.displayStage,
          displayStage: entry.displayStage,
          apCost: entry.apCost,
          mode: entry.mode,
          status: statusByKey.get(entry.key)
        }))
      const count = status => taskResults.filter(result => result.status === status).length
      return {
        success: count('failed') === 0,
        stopped,
        error: null,
        results: [],
        completed: taskResults.filter(result => result.status === 'success').map(result => result.key),
        pending: entries.filter(entry => statusByKey.get(entry.key) !== 'success'),
        loopTimes: 1,
        summary: {
          totalEntries: taskResults.length,
          successCount: count('success'),
          failedCount: count('failed'),
          stoppedCount: count('stopped'),
          pendingCount: count('pending'),
          taskResults
        }
      }
    }
  }
}

function useCopilotSetRuntime(plan, executor) {
  configureCopilotSetRuntimeForTests({
    buildCopilotPlan: async () => plan,
    executeCopilotEntries: executor.execute
  })
}

function copilotSetRequest(body, headers = {}, id = '42') {
  return { headers, params: { id }, body, query: {} }
}

function continueRequest(runId, body = {}) {
  return { headers: {}, query: {}, body: { runId, ...body } }
}

describe('Agent copilot set routes', () => {
  beforeEach(async () => {
    resetAgentRunsForTests()
    resetCopilotSetRunStateForTests()
    await rm(lockFile, { force: true })
  })

  afterEach(async () => {
    resetCopilotSetRunStateForTests()
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
  })

  it('keeps the synchronous continuous response and adds a terminal run identity', async () => {
    const plan = copilotSetPlan(2)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const res = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'cli', selectedIndexes: [] }),
      res,
      () => {}
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.data.success, true)
    assert.equal(res.body.data.mode, 'continuous')
    assert.equal(res.body.data.setId, '42')
    assert.equal(res.body.data.summary.successCount, 2)
    assert.equal(res.body.data.plan.entries.length, 2)
    assert.ok(res.body.data.runId)
    assert.equal(res.headers['X-La-Pluma-Run-Id'], res.body.data.runId)

    const run = getAgentRun(res.body.data.runId)
    assert.equal(run.operationId, 'run_copilot_set')
    assert.equal(run.state, 'succeeded')
    assert.equal(run.result.summary.successCount, 2)
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal'])
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null })
  })

  it('completes a set whose selected entries are already done without a device command', async () => {
    const plan = copilotSetPlan(1)
    plan.entries[0].completed = true
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const res = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({}),
      res,
      () => {}
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.finished, true)
    assert.equal(res.body.data.summary.totalEntries, 0)
    assert.equal(res.body.data.summary.alreadyCompletedCount, 1)
    assert.equal(getAgentRun(res.body.data.runId).state, 'succeeded')
    assert.deepEqual(executor.executed, [])
  })

  it('maps the legacy app mode to the same continuous run', async () => {
    const plan = copilotSetPlan(1)
    useCopilotSetRuntime(plan, createCopilotSetExecutor(plan))

    const res = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'app' }),
      res,
      () => {}
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'continuous')
    assert.equal(res.body.data.summary.successCount, 1)
    assert.equal(getAgentRun(res.body.data.runId).state, 'succeeded')
  })

  it('rejects an unknown mode before creating a run', async () => {
    const res = createResponse()
    const forwarded = []
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'auto' }),
      res,
      error => forwarded.push(error)
    )

    assert.equal(forwarded.length, 1)
    assert.equal(forwarded[0].statusCode, 400)
    assert.equal(forwarded[0].code, 'AGENT_VALIDATION_COPILOT_SET_MODE_INVALID')
    assert.deepEqual(listAgentRuns(), [])
  })

  it('accepts a continuous set in the background and reaches a terminal run', async () => {
    const plan = copilotSetPlan(2)
    useCopilotSetRuntime(plan, createCopilotSetExecutor(plan))

    const res = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ waitForCompletion: false }),
      res,
      () => {}
    )

    assert.equal(res.statusCode, 202)
    assert.equal(res.body.data.accepted, true)
    assert.equal(res.body.data.mode, 'continuous')
    assert.ok(res.body.data.runId)
    assert.equal(res.headers.Location, `/api/agent/runs/${res.body.data.runId}`)

    const terminal = await waitForSnapshot(() => {
      const run = getAgentRun(res.body.data.runId)
      return run && run.state === 'succeeded' ? run : null
    })
    assert.equal(terminal.result.summary.successCount, 2)
  })

  it('keeps a continuous set observable in the snapshot while it executes', async () => {
    const plan = copilotSetPlan(2)
    let releaseFirstEntry
    const firstEntryGate = new Promise(resolve => {
      releaseFirstEntry = resolve
    })
    let gated = false
    const executor = createCopilotSetExecutor(plan, {
      onExecute: async () => {
        if (gated) return
        gated = true
        await firstEntryGate
      }
    })
    useCopilotSetRuntime(plan, executor)

    const res = createResponse()
    const request = findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ waitForCompletion: false }),
      res,
      () => {}
    )

    const snapshot = await waitForSnapshot(async () => {
      const current = createResponse()
      await findHandler('get', '/runs/current')({ headers: {}, query: {} }, current, () => {})
      return current.body?.data?.run?.progress?.phase === 'running' ? current : null
    })

    assert.equal(snapshot.body.data.run.operationId, 'run_copilot_set')
    assert.equal(snapshot.body.data.run.state, 'running')
    assert.equal(snapshot.body.data.run.progress.setId, '42')
    assert.equal(snapshot.body.data.run.progress.currentEntry.key, '0:100:normal')
    assert.equal(snapshot.body.data.run.progress.totalSteps, 2)
    assert.equal(snapshot.body.data.occupancy.runId, snapshot.body.data.run.runId)

    releaseFirstEntry()
    await request
    const terminal = await waitForSnapshot(() => {
      const run = getAgentRun(res.body.data.runId)
      return run && run.state === 'succeeded' ? run : null
    })
    assert.equal(terminal.result.summary.successCount, 2)
  })

  it('stops a running continuous set before the next entry starts', async () => {
    const plan = copilotSetPlan(3)
    let releaseFirstEntry
    const firstEntryGate = new Promise(resolve => {
      releaseFirstEntry = resolve
    })
    let gated = false
    const executor = createCopilotSetExecutor(plan, {
      onExecute: async () => {
        if (gated) return
        gated = true
        await firstEntryGate
      }
    })
    useCopilotSetRuntime(plan, executor)

    const res = createResponse()
    const request = findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ waitForCompletion: false }),
      res,
      () => {}
    )
    const snapshot = await waitForSnapshot(async () => {
      const current = createResponse()
      await findHandler('get', '/runs/current')({ headers: {}, query: {} }, current, () => {})
      return current.body?.data?.run?.progress?.phase === 'running' ? current : null
    })
    const runId = snapshot.body.data.run.runId

    const stopped = createResponse()
    await findHandler('post', '/actions/stop')({ headers: {}, query: {}, body: { runId } }, stopped, () => {})
    assert.equal(stopped.statusCode, 200)
    assert.equal(stopped.body.data.run.state, 'stopping')

    releaseFirstEntry()
    await request
    const terminal = await waitForSnapshot(() => {
      const run = getAgentRun(runId)
      return run && run.state === 'stopped' ? run : null
    })

    assert.equal(terminal.result.stopped, true)
    assert.equal(terminal.result.summary.successCount, 1)
    assert.equal(terminal.result.summary.pendingCount, 2)
    assert.deepEqual(executor.executed, ['0:100:normal'])
  })

  it('replays an idempotent copilot set submission instead of executing twice', async () => {
    const plan = copilotSetPlan(1)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)
    const headers = { 'idempotency-key': 'copilot-set:replay:1' }

    const first = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ selectedIndexes: [] }, headers),
      first,
      () => {}
    )
    assert.equal(first.statusCode, 200)

    const replay = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ selectedIndexes: [] }, headers),
      replay,
      () => {}
    )

    assert.equal(replay.statusCode, 200)
    assert.equal(replay.body.data.runId, first.body.data.runId)
    assert.equal(replay.headers['Idempotency-Replayed'], 'true')
    assert.equal(executor.executed.length, 1)
  })

  it('rejects a busy lease before execution and releases the idempotency key', async () => {
    const plan = copilotSetPlan(1)
    useCopilotSetRuntime(plan, createCopilotSetExecutor(plan))
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      source: 'other-client',
      taskName: '其他执行',
      command: 'run',
      startedAt: new Date().toISOString()
    }))
    const headers = { 'idempotency-key': 'copilot-set:busy:1' }

    const busy = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({}, headers),
      busy,
      () => {}
    )

    assert.equal(busy.statusCode, 409)
    assert.equal(busy.body.error.code, 'MAA_EXECUTION_BUSY')
    assert.equal(busy.body.error.retryable, true)
    assert.equal(getAgentRun(busy.body.error.details.runId).state, 'failed')

    await rm(lockFile, { force: true })
    const retry = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({}, headers),
      retry,
      () => {}
    )

    assert.equal(retry.statusCode, 200)
    assert.notEqual(retry.body.data.runId, busy.body.error.details.runId)
    assert.equal(getAgentRun(retry.body.data.runId).state, 'succeeded')
  })

  it('exposes a manual set waiting between entries and resumes it on demand', async () => {
    const plan = copilotSetPlan(2)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const started = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'manual' }),
      started,
      () => {}
    )

    assert.equal(started.statusCode, 200)
    assert.equal(started.body.data.waitingForNext, true)
    assert.equal(started.body.data.nextEntry.key, '1:101:normal')
    assert.equal(started.body.data.summary.successCount, 1)
    const runId = started.body.data.runId
    assert.equal(getAgentRun(runId).state, 'waiting')
    assert.deepEqual(await getMaaExecutionLeaseSnapshot(), { state: 'free', owner: null })

    const snapshot = createResponse()
    await findHandler('get', '/runs/current')({ headers: {}, query: {} }, snapshot, () => {})
    assert.equal(snapshot.body.data.run.runId, runId)
    assert.equal(snapshot.body.data.run.state, 'waiting')
    assert.equal(snapshot.body.data.run.progress.phase, 'waiting_for_next')
    assert.equal(snapshot.body.data.run.progress.pendingCount, 1)
    assert.equal(snapshot.body.data.occupancy.state, 'pending')
    assert.equal(snapshot.body.data.occupancy.runState, 'waiting')

    const continued = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(
      continueRequest(runId),
      continued,
      () => {}
    )

    assert.equal(continued.statusCode, 200)
    assert.equal(continued.body.data.finished, true)
    assert.equal(continued.body.data.waitingForNext, false)
    assert.equal(continued.body.data.run.state, 'succeeded')
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal'])
    assert.equal(getAgentRun(runId).result.summary.successCount, 2)

    const repeated = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(
      continueRequest(runId),
      repeated,
      () => {}
    )
    assert.equal(repeated.statusCode, 200)
    assert.equal(repeated.body.data.alreadyTerminal, true)
  })

  it('cycles a manual set through waiting until every selected entry is attempted', async () => {
    const plan = copilotSetPlan(3)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const started = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'manual' }),
      started,
      () => {}
    )
    const runId = started.body.data.runId
    assert.equal(started.body.data.waitingForNext, true)
    assert.equal(getAgentRun(runId).state, 'waiting')

    const second = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(continueRequest(runId), second, () => {})
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.data.waitingForNext, true)
    assert.equal(second.body.data.nextEntry.key, '2:102:normal')
    assert.equal(getAgentRun(runId).state, 'waiting')
    assert.equal(getAgentRun(runId).result.summary.successCount, 2)

    const third = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(continueRequest(runId), third, () => {})
    assert.equal(third.statusCode, 200)
    assert.equal(third.body.data.finished, true)
    assert.equal(getAgentRun(runId).state, 'succeeded')
    assert.deepEqual(executor.executed, ['0:100:normal', '1:101:normal', '2:102:normal'])
  })

  it('keeps the set waiting when the next entry cannot acquire the lease', async () => {
    const plan = copilotSetPlan(2)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const started = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'manual' }),
      started,
      () => {}
    )
    const runId = started.body.data.runId

    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      source: 'other-client',
      taskName: '其他执行',
      command: 'run',
      startedAt: new Date().toISOString()
    }))

    const busy = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(
      continueRequest(runId),
      busy,
      () => {}
    )

    assert.equal(busy.statusCode, 409)
    assert.equal(busy.body.error.code, 'MAA_EXECUTION_BUSY')
    assert.equal(busy.body.error.retryable, true)
    assert.equal(getAgentRun(runId).state, 'waiting')
    assert.equal(getAgentRun(runId).result.summary.pendingCount, 1)
    assert.deepEqual(executor.executed, ['0:100:normal'])

    await rm(lockFile, { force: true })
    const continued = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(
      continueRequest(runId),
      continued,
      () => {}
    )
    assert.equal(continued.statusCode, 200)
    assert.equal(getAgentRun(runId).state, 'succeeded')
  })

  it('stops a waiting manual set and never starts the next entry', async () => {
    const plan = copilotSetPlan(3)
    const executor = createCopilotSetExecutor(plan)
    useCopilotSetRuntime(plan, executor)

    const started = createResponse()
    await findHandler('post', '/copilot-sets/:id/execute')(
      copilotSetRequest({ mode: 'manual' }),
      started,
      () => {}
    )
    const runId = started.body.data.runId

    const stopped = createResponse()
    await findHandler('post', '/actions/stop')({ headers: {}, query: {}, body: { runId } }, stopped, () => {})

    assert.equal(stopped.statusCode, 200)
    assert.equal(stopped.body.data.waitingRunStopped, true)
    assert.equal(stopped.body.data.deviceStopRequested, false)
    assert.equal(stopped.body.data.run.state, 'stopped')
    assert.equal(stopped.body.data.run.result.summary.successCount, 1)
    assert.equal(stopped.body.data.run.result.summary.pendingCount, 2)

    const continued = createResponse()
    await findHandler('post', '/actions/continue-copilot-set')(
      continueRequest(runId),
      continued,
      () => {}
    )
    assert.equal(continued.statusCode, 200)
    assert.equal(continued.body.data.alreadyTerminal, true)
    assert.deepEqual(executor.executed, ['0:100:normal'])
  })
})
