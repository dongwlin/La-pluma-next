import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  it('rejects an invalid PORT from the environment before starting any listener', async () => {
    await assert.rejects(
      startLaPlumaServer({ env: { PORT: 'not-a-port' } }),
      error => error.code === 'RUNTIME_CONFIG_INVALID' && error.variableName === 'PORT'
    )
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
    await writeFile(join(clientDistPath, 'manifest.webmanifest'), '{"name":"La Pluma Next fixture"}')
    await writeFile(join(clientDistPath, 'sw.js'), 'globalThis.fixtureServiceWorker = true')

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

    const subPathShell = await fetch(`${origin}/la-pluma/`)
    assert.equal(subPathShell.status, 200)
    assert.match(await subPathShell.text(), /La Pluma Next fixture/)

    const mountRedirect = await fetch(`${origin}/la-pluma`, { redirect: 'manual' })
    assert.equal(mountRedirect.status, 301)
    assert.equal(mountRedirect.headers.get('location'), '/la-pluma/')

    for (const [file, mimePattern] of [
      ['manifest.webmanifest', /application\/manifest\+json/],
      ['sw.js', /javascript/]
    ]) {
      const response = await fetch(`${origin}/la-pluma/${file}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), mimePattern)
    }

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

  it('serves the root deployment shell, deep links and PWA resources at the origin root', async () => {
    const clientDistPath = await mkdtemp(join(tmpdir(), 'la-pluma-client-root-'))
    tempDirs.push(clientDistPath)
    await mkdir(join(clientDistPath, 'assets'))
    await writeFile(join(clientDistPath, 'index.html'), '<!doctype html><title>La Pluma Next root fixture</title>')
    await writeFile(join(clientDistPath, 'assets', 'app.js'), 'globalThis.fixtureLoaded = true')
    await writeFile(join(clientDistPath, 'manifest.webmanifest'), '{"name":"La Pluma Next root fixture"}')
    await writeFile(join(clientDistPath, 'sw.js'), 'globalThis.fixtureServiceWorker = true')

    const signalingGateway = {
      proxyPath: WEBRTC_SIGNALING_PATH,
      handleLogin(_req, res) {
        return res.json({ token: 'fixture-ticket' })
      }
    }
    const app = createLaPlumaApp({
      env: { NODE_ENV: 'production' },
      signalingGateway,
      clientDistPath
    })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}`

    const shell = await fetch(origin)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /La Pluma Next root fixture/)

    const deepLink = await fetch(`${origin}/automation/deep/link`)
    assert.equal(deepLink.status, 200)
    assert.match(await deepLink.text(), /La Pluma Next root fixture/)

    const asset = await fetch(`${origin}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type'), /javascript/)

    for (const [file, mimePattern] of [
      ['manifest.webmanifest', /application\/manifest\+json/],
      ['sw.js', /javascript/]
    ]) {
      const response = await fetch(`${origin}/${file}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), mimePattern)
    }

    const missingAsset = await fetch(`${origin}/assets/missing.js`)
    assert.equal(missingAsset.status, 404)

    const health = await fetch(`${origin}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { success: true, status: 'ok' })

    const apiMiss = await fetch(`${origin}/api/agent/nonexistent-endpoint`)
    assert.equal(apiMiss.status, 404)
    assert.equal((await apiMiss.json()).error.code, 'AGENT_ROUTE_NOT_FOUND')

    const hiddenSignaling = await fetch(`${origin}${WEBRTC_SIGNALING_PATH}/devices`)
    assert.equal(hiddenSignaling.status, 404)
    assert.deepEqual(await hiddenSignaling.json(), { error: 'Not Found' })
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

describe('Cross-origin and auth middleware order', () => {
  const CROSS_ORIGIN = 'http://console.example:5173'

  it('answers preflight OPTIONS before auth and without credential headers', async () => {
    const app = createLaPlumaApp({ env: { LA_PLUMA_TOKEN: 'api-secret' } })
    const port = await listen(app)

    const preflight = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: CROSS_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,x-la-pluma-token,content-type'
      }
    })

    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/)
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /x-la-pluma-token/)
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null)

    // 预检在路由匹配之前应答：未匹配的 API 路径同样返回 204 而不是 401/404
    const unknownPreflight = await fetch(`http://127.0.0.1:${port}/api/agent/nonexistent-endpoint`, {
      method: 'OPTIONS',
      headers: {
        Origin: CROSS_ORIGIN,
        'Access-Control-Request-Method': 'GET'
      }
    })
    assert.equal(unknownPreflight.status, 204)
    assert.equal(unknownPreflight.headers.get('access-control-allow-origin'), '*')
  })

  it('answers preflight for the token-protected ticket endpoint behind CORS', async () => {
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

    const preflight = await fetch(`http://127.0.0.1:${port}${WEBRTC_SIGNALING_PATH}/api/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: CROSS_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization'
      }
    })

    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null)

    const ticket = await fetch(`http://127.0.0.1:${port}${WEBRTC_SIGNALING_PATH}/api/login`, {
      method: 'POST',
      headers: {
        Origin: CROSS_ORIGIN,
        Authorization: 'Bearer api-secret'
      }
    })
    assert.equal(ticket.status, 200)
    assert.deepEqual(await ticket.json(), { token: 'one-use-ticket' })
    assert.equal(ticket.headers.get('access-control-allow-origin'), '*')
  })

  it('authenticates cross-origin API calls by token headers and keeps 401 ahead of the parser', async () => {
    const app = createLaPlumaApp({ env: { LA_PLUMA_TOKEN: 'api-secret' } })
    const port = await listen(app)
    const url = `http://127.0.0.1:${port}/api/agent/nonexistent-endpoint`

    const missingToken = await fetch(url, { headers: { Origin: CROSS_ORIGIN } })
    assert.equal(missingToken.status, 401)
    assert.equal((await missingToken.json()).error.code, 'AGENT_AUTH_REQUIRED')
    assert.equal(missingToken.headers.get('access-control-allow-origin'), '*')
    assert.equal(missingToken.headers.get('access-control-allow-credentials'), null)

    const wrongToken = await fetch(url, {
      headers: { Origin: CROSS_ORIGIN, 'X-La-Pluma-Token': 'not-the-secret' }
    })
    assert.equal(wrongToken.status, 401)
    assert.equal((await wrongToken.json()).error.code, 'AGENT_AUTH_REQUIRED')

    const bearerToken = await fetch(url, {
      headers: { Origin: CROSS_ORIGIN, Authorization: 'Bearer api-secret' }
    })
    assert.equal(bearerToken.status, 404)
    assert.equal((await bearerToken.json()).error.code, 'AGENT_ROUTE_NOT_FOUND')

    const headerToken = await fetch(url, {
      headers: { Origin: CROSS_ORIGIN, 'X-La-Pluma-Token': 'api-secret' }
    })
    assert.equal(headerToken.status, 404)
    assert.equal((await headerToken.json()).error.code, 'AGENT_ROUTE_NOT_FOUND')
  })

  it('rejects an invalid token before parsing an invalid request body', async () => {
    const app = createLaPlumaApp({ env: { LA_PLUMA_TOKEN: 'api-secret' } })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer wrong-token',
        Origin: CROSS_ORIGIN
      },
      body: '{"broken'
    })

    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'AGENT_AUTH_REQUIRED')
  })

  it('maps an invalid body to the stable 400 once the token is accepted', async () => {
    const app = createLaPlumaApp({ env: { LA_PLUMA_TOKEN: 'api-secret' } })
    const port = await listen(app)

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer api-secret',
        Origin: CROSS_ORIGIN
      },
      body: '{"broken'
    })

    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'AGENT_REQUEST_BODY_INVALID')
    assert.equal(body.error.retryable, false)
  })

  it('keeps hidden signaling admin endpoints 404 while remaining origin-agnostic', async () => {
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

    const hidden = await fetch(`http://127.0.0.1:${port}${WEBRTC_SIGNALING_PATH}/devices`, {
      headers: { Origin: CROSS_ORIGIN }
    })
    assert.equal(hidden.status, 404)
    assert.deepEqual(await hidden.json(), { error: 'Not Found' })

    // 同源请求（无 Origin 头）行为不变：鉴权仍由 token 决定，与来源无关
    const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/agent/nonexistent-endpoint`)
    assert.equal(sameOrigin.status, 401)
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

describe('Server runtime assembly', () => {
  const runStoreSummary = {
    filePath: '/tmp/test-agent-runs.json',
    restoredRuns: 0,
    interruptedRuns: 0,
    prunedRuns: 0
  }

  it('closes runtime domains before the transport and reuses the first close result', async () => {
    const events = []
    const signalingGateway = {
      proxyPath: WEBRTC_SIGNALING_PATH,
      attach() {},
      handleLogin(_req, res) {
        res.status(404).end()
      },
      close() {
        events.push('signaling-gateway')
      }
    }

    const runtime = await startLaPlumaServer({
      env: {},
      host: '127.0.0.1',
      port: 0,
      signalingGateway,
      initializeRunStore: async () => runStoreSummary,
      initializeRuntime: async ({ lifecycle }) => {
        assert.equal(lifecycle.getState(), 'starting')
        lifecycle.register({
          name: 'fixture-runtime-domain',
          close: () => {
            events.push('runtime-domain')
          }
        })
        events.push('runtime-initialized')
      },
      logger: { log() {}, error() {} }
    })

    try {
      assert.equal(runtime.lifecycle.getState(), 'running')
      assert.equal(runtime.lifecycle.isDraining(), false)
      assert.equal(runtime.server.listening, true)

      const summary = await runtime.close('test')

      assert.deepEqual(events, ['runtime-initialized', 'runtime-domain', 'signaling-gateway'])
      assert.deepEqual(summary.steps.map(step => step.name), ['fixture-runtime-domain', 'http-transport', 'webrtc-preview'])
      assert.equal(summary.ok, true)
      assert.equal(runtime.server.listening, false)
      assert.equal(runtime.lifecycle.getState(), 'closed')

      const repeated = await runtime.close('again')
      assert.equal(repeated, summary)
      assert.deepEqual(events, ['runtime-initialized', 'runtime-domain', 'signaling-gateway'])
    } finally {
      if (runtime.server.listening) await runtime.close('cleanup')
    }
  })

  it('releases the transport when the listen step fails', async () => {
    const blocker = createServer()
    servers.push(blocker)
    await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const blockedPort = blocker.address().port

    const events = []
    const signalingGateway = {
      proxyPath: WEBRTC_SIGNALING_PATH,
      attach() {
        events.push('attach')
      },
      handleLogin(_req, res) {
        res.status(404).end()
      },
      close() {
        events.push('signaling-gateway')
      }
    }

    await assert.rejects(
      startLaPlumaServer({
        env: {},
        host: '127.0.0.1',
        port: blockedPort,
        signalingGateway,
        initializeRunStore: async () => runStoreSummary,
        initializeRuntime: async () => {
          events.push('runtime-initialized')
        },
        logger: { log() {}, error() {} }
      }),
      error => error.code === 'RUNTIME_LIFECYCLE_START_FAILED' && error.stepName === 'http-transport'
    )

    assert.deepEqual(events, ['attach', 'signaling-gateway'])
  })

  it('does not start listeners, timers or runtime domains when the entry is imported', async () => {
    const entry = new URL('../server.js', import.meta.url).href
    const script = `await import(${JSON.stringify(entry)}); process.stdout.write('imported');`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const result = await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(
          `server entry import did not exit; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
        ))
      }, 10_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr })
      })
    })

    assert.equal(result.signal, null)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'imported')
    assert.equal(result.stderr, '')
  })
})
