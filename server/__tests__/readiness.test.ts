import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp, startLaPlumaServer } from '../server.ts'
import {
  initializeAgentRunStore,
  shutdownAgentRunStoreForTests
} from '../services/agentRunService.ts'
import { createRuntimeLifecycle } from '../services/runtimeLifecycleService.ts'
import { createRuntimeReadinessTracker } from '../services/runtimeReadinessService.ts'
import type {
  AgentRunStoreReadinessStatus,
  ReadinessLifecyclePort
} from '../services/runtimeReadinessService.ts'
import type { RuntimeLifecycleState } from '../services/runtimeLifecycleService.ts'
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.ts'
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts'

const servers: Server[] = []
const tempDirs: string[] = []
/** 组装与存储日志端口：静默实现，避免用例向 stdout 混入运行时日志。 */
interface SilentLogger {
  log(): void
  info(): void
  warn(): void
  error(): void
}
const silentLogger: SilentLogger = { log() {}, info() {}, warn() {}, error() {} }

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(response: Response): Promise<JsonRecord> {
  const body: unknown = await response.json()
  assert.ok(isRecord(body), '响应应为 JSON 对象')
  return body
}

function readNested(payload: JsonRecord, key: string): JsonRecord {
  const value = payload[key]
  assert.ok(isRecord(value), `${key} 应为 JSON 对象`)
  return value
}

function readError(payload: JsonRecord): JsonRecord {
  const error = payload.error
  assert.ok(isRecord(error), '错误信封应包含 error 对象')
  return error
}

async function listen(app: RequestListener): Promise<string> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('监听端口获取失败')
  }
  return `http://127.0.0.1:${address.port}`
}

function fixedLifecycle(state: RuntimeLifecycleState): ReadinessLifecyclePort {
  return { getState: () => state }
}

/** 存储状态夹具：路径与错误只用于证明响应不泄露它们。 */
interface RunStoreStatusFixture extends AgentRunStoreReadinessStatus {
  filePath?: string
  error?: string
}

function readyTracker() {
  const tracker = createRuntimeReadinessTracker({
    lifecycle: fixedLifecycle('running'),
    runStoreStatus: (): RunStoreStatusFixture => ({ required: true, ready: true })
  })
  tracker.markInitializationCompleted()
  return tracker
}

/** 信令网关桩：应用只读取 proxyPath 与登录入口，本文件不建立 WebRTC 连接。 */
function stubSignalingGateway(): WebrtcSignalingGateway {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    async handleLogin(_req, res) {
      res.json({ token: 'fixture-ticket' })
    },
    async handleUpgrade() {},
    attach() {},
    close() {}
  }
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    assert.ok(server)
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  while (tempDirs.length) await rm(tempDirs.pop() as string, { recursive: true, force: true })
})

describe('Readiness endpoint matrix', () => {
  it('keeps standalone and starting runtimes not ready', async () => {
    const defaultOrigin = await listen(createLaPlumaApp({ env: {} }))
    const defaultResponse = await fetch(`${defaultOrigin}/readiness`)
    assert.equal(defaultResponse.status, 503)
    const defaultBody = await readJson(defaultResponse)
    assert.equal(defaultBody.success, false)
    assert.equal(defaultBody.status, 'not_ready')
    const defaultChecks = readNested(defaultBody, 'checks')
    assert.deepEqual(defaultChecks.lifecycle, { ok: false, state: 'unattached' })
    assert.deepEqual(defaultChecks.initialization, { ok: false, state: 'pending' })
    assert.deepEqual(defaultBody.reasons, ['runtime_not_attached', 'initialization_pending'])

    const startingTracker = createRuntimeReadinessTracker({
      lifecycle: fixedLifecycle('starting')
    })
    const startingOrigin = await listen(createLaPlumaApp({ env: {}, readiness: startingTracker }))
    const startingBody = await readJson(await fetch(`${startingOrigin}/readiness`))
    assert.equal(startingBody.status, 'not_ready')
    assert.deepEqual(readNested(startingBody, 'checks').lifecycle, { ok: false, state: 'starting' })
    assert.deepEqual(startingBody.reasons, ['lifecycle_starting', 'initialization_pending'])
  })

  it('distinguishes pending from in-progress initialization', () => {
    const tracker = createRuntimeReadinessTracker({ lifecycle: fixedLifecycle('starting') })
    assert.deepEqual(tracker.snapshot().reasons, ['lifecycle_starting', 'initialization_pending'])

    tracker.markInitializationStarted()
    assert.deepEqual(tracker.snapshot().reasons, ['lifecycle_starting', 'initialization_in_progress'])
  })

  it('reports ready only with a running lifecycle, completed initialization and a ready store', async () => {
    const origin = await listen(createLaPlumaApp({ env: {}, readiness: readyTracker() }))
    const response = await fetch(`${origin}/readiness`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await readJson(response), {
      success: true,
      status: 'ready',
      checks: {
        lifecycle: { ok: true, state: 'running' },
        initialization: { ok: true, state: 'completed' },
        runStore: { ok: true, state: 'ready' }
      },
      reasons: []
    })
  })

  it('stays not ready when runtime initialization failed', async () => {
    const tracker = createRuntimeReadinessTracker({
      lifecycle: fixedLifecycle('running'),
      runStoreStatus: () => ({ required: true, ready: true })
    })
    tracker.markInitializationStarted()
    tracker.markInitializationFailed()

    const origin = await listen(createLaPlumaApp({ env: {}, readiness: tracker }))
    const response = await fetch(`${origin}/readiness`)

    assert.equal(response.status, 503)
    const body = await readJson(response)
    assert.equal(body.status, 'not_ready')
    assert.deepEqual(readNested(body, 'checks').initialization, { ok: false, state: 'failed' })
    assert.deepEqual(body.reasons, ['initialization_failed'])
  })

  it('stays not ready when the run store is unavailable without leaking its path or error', async () => {
    const tracker = createRuntimeReadinessTracker({
      lifecycle: fixedLifecycle('running'),
      runStoreStatus: (): RunStoreStatusFixture => ({
        required: true,
        ready: false,
        filePath: '/run/secrets/agent-runs.json',
        error: 'EACCES: permission denied, open /run/secrets/agent-runs.json'
      })
    })
    tracker.markInitializationCompleted()

    const origin = await listen(createLaPlumaApp({ env: {}, readiness: tracker }))
    const response = await fetch(`${origin}/readiness`)

    assert.equal(response.status, 503)
    const raw = await response.text()
    assert.ok(!raw.includes('/run/secrets'))
    assert.ok(!raw.includes('EACCES'))
    const body = JSON.parse(raw)
    assert.deepEqual(body.checks.runStore, { ok: false, state: 'unavailable' })
    assert.deepEqual(body.reasons, ['run_store_unavailable'])
  })

  it('turns not ready as soon as draining begins while liveness stays up', async () => {
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger })
    let releaseClose: () => void = () => {}
    const hold = new Promise<void>(resolve => { releaseClose = resolve })
    lifecycle.register({ name: 'fixture-hold', close: () => hold })
    await lifecycle.start()

    const tracker = createRuntimeReadinessTracker({
      lifecycle,
      runStoreStatus: () => ({ required: true, ready: true })
    })
    tracker.markInitializationCompleted()
    const origin = await listen(createLaPlumaApp({ env: {}, readiness: tracker }))

    assert.equal((await fetch(`${origin}/readiness`)).status, 200)

    const closing = lifecycle.close('test-draining')
    const draining = await fetch(`${origin}/readiness`)
    assert.equal(draining.status, 503)
    assert.deepEqual((await readJson(draining)).reasons, ['draining'])

    // 存活检查不受关闭中的就绪状态影响：容器不应因 draining 被重启。
    const liveness = await fetch(`${origin}/health`)
    assert.equal(liveness.status, 200)
    assert.deepEqual(await readJson(liveness), { success: true, status: 'ok' })

    releaseClose()
    await closing
    assert.deepEqual((await readJson(await fetch(`${origin}/readiness`))).reasons, ['lifecycle_closed'])
  })

  it('keeps probes independent from API token auth and never echoes the token', async () => {
    const app = createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'probe-secret-token' },
      readiness: readyTracker()
    })
    const origin = await listen(app)

    const probe = await fetch(`${origin}/readiness?token=probe-secret-token`)
    assert.equal(probe.status, 200)
    assert.equal(probe.headers.get('cache-control'), 'no-store')
    assert.ok(!(await probe.text()).includes('probe-secret-token'))

    const api = await fetch(`${origin}/api/agent/status`)
    assert.equal(api.status, 401)
    assert.equal(readError(await readJson(api)).code, 'AGENT_AUTH_REQUIRED')
  })

  it('keeps readiness on the origin root in subpath deployments', async () => {
    const clientDistPath = await mkdtemp(join(tmpdir(), 'la-pluma-readiness-'))
    tempDirs.push(clientDistPath)
    await mkdir(join(clientDistPath, 'assets'))
    await writeFile(join(clientDistPath, 'index.html'), '<!doctype html><title>Readiness fixture</title>')

    const app = createLaPlumaApp({
      env: { NODE_ENV: 'production', LA_PLUMA_BASE_PATH: '/la-pluma/' },
      signalingGateway: stubSignalingGateway(),
      clientDistPath,
      readiness: readyTracker()
    })
    const origin = await listen(app)

    const readiness = await fetch(`${origin}/readiness`)
    assert.equal(readiness.status, 200)
    assert.equal((await readJson(readiness)).status, 'ready')

    // 子路径下的同名路径不得被 SPA 回退接管，也不能泄露应用外壳。
    const shadowed = await fetch(`${origin}/la-pluma/readiness`)
    assert.equal(shadowed.status, 404)
    assert.doesNotMatch(await shadowed.text(), /Readiness fixture/)

    const shell = await fetch(`${origin}/la-pluma/automation`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /Readiness fixture/)
  })
})

describe('Readiness reads stay side-effect free', () => {
  it('imports no device, process or network modules', async () => {
    const source = await readFile(
      new URL('../services/runtimeReadinessService.ts', import.meta.url),
      'utf8'
    )
    for (const forbidden of [
      'maaService',
      'connectionService',
      'outboundRequestService',
      'telegramBotService',
      'webrtcService',
      'child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:dns',
      'node:fs'
    ]) {
      assert.ok(!source.includes(forbidden), `readiness projection must not use ${forbidden}`)
    }
  })
})

describe('Server readiness assembly', () => {
  const runStoreSummary = {
    filePath: '/tmp/test-agent-runs.json',
    restoredRuns: 0,
    interruptedRuns: 0,
    prunedRuns: 0
  }

  it('reports initialization failure over HTTP without leaking the error text', async () => {
    const runtime = await startLaPlumaServer({
      env: {},
      host: '127.0.0.1',
      port: 0,
      initializeRunStore: async () => runStoreSummary,
      initializeRuntime: async () => {
        throw new Error('初始化夹具失败标记')
      },
      logger: silentLogger
    })

    try {
      const origin = `http://127.0.0.1:${runtime.port}`
      const readiness = await fetch(`${origin}/readiness`)
      assert.equal(readiness.status, 503)
      const raw = await readiness.text()
      assert.ok(!raw.includes('初始化夹具失败标记'))
      assert.deepEqual(JSON.parse(raw).reasons, ['initialization_failed'])
      assert.equal((await fetch(`${origin}/health`)).status, 200)
    } finally {
      await runtime.close('cleanup')
    }
  })

  it('reflects an unavailable real run store without leaking its path or error', async () => {
    const runtime = await startLaPlumaServer({
      env: {},
      host: '127.0.0.1',
      port: 0,
      initializeRunStore: () => initializeAgentRunStore({
        filePath: '/tmp/la-pluma-readiness-missing/agent-runs.json',
        readStore: async () => {
          throw new Error('run-store-fixture-failure /tmp/la-pluma-readiness-missing')
        },
        runtimeLogger: silentLogger
      }),
      initializeRuntime: async () => {},
      logger: silentLogger
    })

    try {
      const origin = `http://127.0.0.1:${runtime.port}`
      const readiness = await fetch(`${origin}/readiness`)
      assert.equal(readiness.status, 503)
      const raw = await readiness.text()
      assert.ok(!raw.includes('run-store-fixture-failure'))
      assert.ok(!raw.includes('/tmp/la-pluma-readiness-missing'))
      const body = JSON.parse(raw)
      assert.deepEqual(body.checks.runStore, { ok: false, state: 'unavailable' })
      assert.deepEqual(body.reasons, ['run_store_unavailable'])
      assert.equal((await fetch(`${origin}/health`)).status, 200)
    } finally {
      await runtime.close('cleanup')
      await shutdownAgentRunStoreForTests()
    }
  })

  it('turns not ready for HTTP probes while draining and recovers liveness semantics', async () => {
    let releaseClose: () => void = () => {}
    const hold = new Promise<void>(resolve => { releaseClose = resolve })
    const runtime = await startLaPlumaServer({
      env: {},
      host: '127.0.0.1',
      port: 0,
      initializeRunStore: async () => runStoreSummary,
      initializeRuntime: async ({ lifecycle }) => {
        assert.ok(lifecycle, '组装入口必须传入生命周期端口')
        lifecycle.register({ name: 'fixture-slow-close', close: () => hold })
      },
      logger: silentLogger
    })
    const origin = `http://127.0.0.1:${runtime.port}`

    try {
      assert.equal(runtime.lifecycle.getState(), 'running')
      const ready = await fetch(`${origin}/readiness`)
      assert.equal(ready.status, 200)
      assert.equal((await readJson(ready)).status, 'ready')

      const closing = runtime.close('test-draining')
      const draining = await fetch(`${origin}/readiness`)
      assert.equal(draining.status, 503)
      assert.deepEqual((await readJson(draining)).reasons, ['draining'])
      assert.equal((await fetch(`${origin}/health`)).status, 200)

      releaseClose()
      const summary = await closing
      assert.equal(summary.ok, true)
      assert.equal(runtime.lifecycle.getState(), 'closed')
    } finally {
      releaseClose()
      if (runtime.server.listening) await runtime.close('cleanup')
    }

    await assert.rejects(fetch(`${origin}/readiness`))
  })
})
