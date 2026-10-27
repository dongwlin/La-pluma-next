import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  createLaPlumaApp,
  loadHttpsOptions,
  normalizeBasePath,
  startLaPlumaServer
} from '../server.js'
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.js'
import operatorTraining from '../services/operatorTrainingService.js'
import OperatorQuotes from '../services/operatorQuotesService.js'

const servers = []
const tempDirs = []

async function listen(app) {
  const server = createServer(app)
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true })
})

describe('La Pluma Next transport configuration', () => {
  it('normalizes the production application base path', () => {
    assert.equal(normalizeBasePath(), '/')
    assert.equal(normalizeBasePath('la-pluma'), '/la-pluma/')
    assert.equal(normalizeBasePath('/la-pluma/'), '/la-pluma/')
  })

  it('requires both HTTPS paths and loads both certificate files', () => {
    assert.equal(loadHttpsOptions({}), null)
    assert.throws(
      () => loadHttpsOptions({ LA_PLUMA_HTTPS_CERT_PATH: '/cert.pem' }),
      /必须同时配置/
    )

    const reads = []
    const options = loadHttpsOptions({
      LA_PLUMA_HTTPS_CERT_PATH: '/cert.pem',
      LA_PLUMA_HTTPS_KEY_PATH: '/key.pem'
    }, path => {
      reads.push(path)
      return Buffer.from(path)
    })
    assert.deepEqual(reads, ['/cert.pem', '/key.pem'])
    assert.equal(options.cert.toString(), '/cert.pem')
    assert.equal(options.key.toString(), '/key.pem')
  })

  it('protects ticket issuance with LA_PLUMA_TOKEN and hides all other HTTP paths', async () => {
    const signalingGateway = {
      proxyPath: WEBRTC_SIGNALING_PATH,
      handleLogin(_req, res) {
        return res.json({ token: 'one-use-ticket' })
      }
    }
    const app = createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway
    })
    const port = await listen(app)
    const baseUrl = `http://127.0.0.1:${port}${WEBRTC_SIGNALING_PATH}`

    const unauthorized = await fetch(`${baseUrl}/api/login`, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'AGENT_AUTH_REQUIRED')

    const authorized = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { Authorization: 'Bearer api-secret' }
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), { token: 'one-use-ticket' })

    const hidden = await fetch(`${baseUrl}/devices`)
    assert.equal(hidden.status, 404)
    assert.deepEqual(await hidden.json(), { error: 'Not Found' })
  })

  it('serves the production shell and assets from the configured base path', async () => {
    const clientDistPath = await mkdtemp(join(tmpdir(), 'la-pluma-client-'))
    tempDirs.push(clientDistPath)
    await mkdir(join(clientDistPath, 'assets'))
    await writeFile(join(clientDistPath, 'index.html'), '<!doctype html><title>La Pluma Next fixture</title>')
    await writeFile(join(clientDistPath, 'assets', 'app.js'), 'globalThis.fixtureLoaded = true')

    const signalingGateway = {
      proxyPath: WEBRTC_SIGNALING_PATH,
      handleLogin(_req, res) {
        return res.json({ token: 'fixture-ticket' })
      }
    }
    const app = createLaPlumaApp({
      env: { NODE_ENV: 'production', LA_PLUMA_BASE_PATH: '/la-pluma/' },
      signalingGateway,
      clientDistPath
    })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}`

    const shell = await fetch(`${origin}/la-pluma/automation`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /La Pluma Next fixture/)

    const asset = await fetch(`${origin}/la-pluma/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type'), /javascript/)
    assert.match(await asset.text(), /fixtureLoaded/)

    const missingAsset = await fetch(`${origin}/la-pluma/assets/missing.js`)
    assert.equal(missingAsset.status, 404)

    const wrongRoot = await fetch(`${origin}/`)
    assert.equal(wrongRoot.status, 404)

    for (const reservedPath of ['api', 'health', 'webrtc-signaling']) {
      const reservedResponse = await fetch(`${origin}/la-pluma/${reservedPath}`)
      assert.equal(reservedResponse.status, 404)
      assert.doesNotMatch(await reservedResponse.text(), /La Pluma Next fixture/)
    }
  })

  it('starts on an ephemeral HTTP port and closes without leaving a listener', async () => {
    const runtime = await startLaPlumaServer({
      env: {},
      host: '127.0.0.1',
      port: 0,
      initializeRunStore: async () => ({
        filePath: '/tmp/test-agent-runs.json',
        restoredRuns: 0,
        interruptedRuns: 0,
        prunedRuns: 0
      }),
      initializeRuntime: async () => {},
      logger: { log() {}, error() {} }
    })

    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/health`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { success: true, status: 'ok' })
      assert.equal(runtime.server.listening, true)
    } finally {
      await runtime.close()
    }
    assert.equal(runtime.server.listening, false)
  })
})

describe('API unified error exit', () => {
  const servers = []
  const consoleLines = []
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

  function captureConsole() {
    console.error = (...parts) => consoleLines.push(parts.join(' '))
  }

  afterEach(async () => {
    console.error = originalConsoleError
    consoleLines.length = 0
    while (servers.length) {
      const server = servers.pop()
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('maps malformed JSON bodies to a stable JSON error', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken'
    })

    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.success, false)
    assert.equal(body.message, '请求体不是有效的 JSON')
    assert.equal(body.error.code, 'AGENT_REQUEST_BODY_INVALID')
    assert.deepEqual(body.error.details, {})
    assert.equal(body.error.retryable, false)
  })

  it('maps oversized JSON bodies to a stable 413', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(200_000) })
    })

    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'AGENT_REQUEST_BODY_TOO_LARGE')
    assert.equal(body.message, '请求体超过允许的大小')
  })

  it('maps undecodable path params to a stable 400 without echoing the raw value', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/runs/%E0%A4%A`)

    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'AGENT_REQUEST_PATH_INVALID')
    assert.equal(body.message, '请求路径参数无法解码')
    assert.ok(!JSON.stringify(body).includes('%E0%A4%A'))
  })

  it('answers unmatched API paths with JSON 404 without echoing path or query', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/nonexistent-endpoint?token=secret-query-value`)

    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.success, false)
    assert.equal(body.message, '接口不存在')
    assert.equal(body.error.code, 'AGENT_ROUTE_NOT_FOUND')
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('secret-query-value'))
    assert.ok(!raw.includes('nonexistent-endpoint'))
  })

  it('keeps token auth ahead of the API 404 answer', async () => {
    const app = createLaPlumaApp({ env: { LA_PLUMA_TOKEN: 'api-secret' } })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/nonexistent-endpoint`)

    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'AGENT_AUTH_REQUIRED')
  })

  it('keeps declared business errors intact through the unified exit', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const originalApply = operatorTraining.applyPlanToTasks
    operatorTraining.applyPlanToTasks = async () => {
      throw Object.assign(new Error('养成队列已变化，请重新生成计划后应用'), { statusCode: 409 })
    }
    captureConsole()

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/actions/apply-training-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'error-exit-409' },
        body: JSON.stringify({ plan: { queueRevision: 'stale' } })
      })

      assert.equal(response.status, 409)
      const body = await response.json()
      assert.equal(body.success, false)
      assert.equal(body.message, '养成队列已变化，请重新生成计划后应用')
      assert.equal(body.meta.requestId, 'error-exit-409')
      assert.ok(consoleLines[0].includes('[API] POST /api/agent/actions/apply-training-plan -> 409'))
    } finally {
      operatorTraining.applyPlanToTasks = originalApply
    }
  })

  it('hides unknown internal errors behind a generic 500 and never logs the query', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const originalApply = operatorTraining.applyPlanToTasks
    operatorTraining.applyPlanToTasks = async () => {
      throw new Error('内部堆栈泄露标记 /etc/la-pluma/token')
    }
    captureConsole()

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/actions/apply-training-plan?token=secret-query-value`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: { queueRevision: 'stale' } })
      })

      assert.equal(response.status, 500)
      const body = await response.json()
      assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR')
      assert.equal(body.message, '服务器内部错误')
      assert.deepEqual(body.error.details, {})
      assert.equal(body.error.retryable, false)
      assert.ok(!JSON.stringify(body).includes('内部堆栈泄露标记'))
      const logged = consoleLines.join('\n')
      assert.ok(!logged.includes('内部堆栈泄露标记'))
      assert.ok(!logged.includes('secret-query-value'))
      assert.ok(logged.includes('[API] POST /api/agent/actions/apply-training-plan -> 500'))
    } finally {
      operatorTraining.applyPlanToTasks = originalApply
    }
  })

  it('routes sync exceptions through the unified exit', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const originalGetAllQuotes = OperatorQuotes.getAllQuotes
    OperatorQuotes.getAllQuotes = () => {
      throw new Error('同步异常泄露标记')
    }
    captureConsole()

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/operator-quotes/all`)

      assert.equal(response.status, 500)
      const body = await response.json()
      assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR')
      assert.equal(body.message, '服务器内部错误')
      assert.ok(!JSON.stringify(body).includes('同步异常泄露标记'))
    } finally {
      OperatorQuotes.getAllQuotes = originalGetAllQuotes
    }
  })

  it('keeps the default HTML 404 for non-API paths', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/definitely-missing`)

    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') || '', /html/)
  })
})
