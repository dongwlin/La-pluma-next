import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { createLaPlumaServer, installShutdownHandlers } from '../server.ts'
import type { StartLaPlumaServerOptions } from '../server.ts'
import { getExecutionAdmissionGate } from '../services/executionAdmissionService.ts'
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.ts'
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts'

const runStoreSummary = { filePath: '/tmp/test-agent-runs.json', restoredRuns: 0, interruptedRuns: 0, prunedRuns: 0 }
const silentLogger = { log() {}, warn() {}, error() {} }

function stubGateway(events: string[], close?: () => void): WebrtcSignalingGateway {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    async handleLogin(_req, res) { res.status(503).end() },
    async handleUpgrade() {},
    attach() { events.push('gateway-attached') },
    close: close ?? (() => { events.push('gateway-closed') })
  }
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

function createServer(overrides: StartLaPlumaServerOptions = {}) {
  return createLaPlumaServer({
    env: {},
    host: '127.0.0.1',
    port: 0,
    initializeRunStore: async () => runStoreSummary,
    initializeRuntime: async () => {},
    logger: silentLogger,
    executionShutdownOptions: {
      runtime: {
        listActiveRuns: () => [],
        isDeviceTaskRunning: () => false,
        isScheduleRunning: () => false,
        flushRunStore: async () => {}
      }
    },
    ...overrides
  })
}

describe('Server construction and startup', () => {
  it('defers listeners and initialization, then reuses a single start', async () => {
    const events: string[] = []
    const runtime = createServer({
      signalingGateway: stubGateway(events),
      initializeRunStore: async () => { events.push('run-store'); return runStoreSummary },
      initializeRuntime: async () => { events.push('runtime-initialized') }
    })
    assert.equal(runtime.lifecycle.getState(), 'idle')
    assert.equal(runtime.server.listening, false)
    assert.deepEqual(events, [])

    try {
      const starting = runtime.start()
      assert.equal(runtime.start(), starting)
      assert.equal(await starting, runtime)
      assert.ok(runtime.port > 0)
      assert.deepEqual(events, ['run-store', 'gateway-attached', 'runtime-initialized'])
    } finally {
      await runtime.close('cleanup')
    }
    assert.equal(runtime.server.listening, false)
  })

  it('closes before start without acquiring transport resources or initializing domains', async () => {
    const events: string[] = []
    const runtime = createServer({
      signalingGateway: stubGateway(events),
      initializeRunStore: async () => { events.push('run-store'); return runStoreSummary },
      initializeRuntime: async () => { events.push('runtime-initialized') }
    })
    assert.equal((await runtime.close('cancelled-before-start')).ok, true)
    await assert.rejects(runtime.start(), { code: 'RUNTIME_LIFECYCLE_CLOSED' })
    assert.equal(runtime.server.listening, false)
    assert.equal(getExecutionAdmissionGate()?.isClosed(), true)
    assert.deepEqual(events, [])
  })

  it('validates TLS before replacing process-wide runtime ownership', () => {
    const events: string[] = []
    const gate = getExecutionAdmissionGate()
    assert.throws(() => createServer({
      env: { LA_PLUMA_HTTPS_CERT_PATH: '/unused/cert.pem' },
      signalingGateway: stubGateway(events)
    }), /必须同时配置/)
    assert.equal(getExecutionAdmissionGate(), gate)
    assert.deepEqual(events, [])
  })

  it('skips listening when close is requested during Run store recovery', async () => {
    const entered = deferred()
    const release = deferred()
    const events: string[] = []
    const runtime = createServer({
      signalingGateway: stubGateway(events),
      initializeRunStore: async () => {
        entered.resolve()
        await release.promise
        return runStoreSummary
      },
      initializeRuntime: async () => { events.push('runtime-initialized') }
    })
    const starting = runtime.start()
    await entered.promise
    try {
      const closing = runtime.close('cancelled-during-recovery')
      assert.equal(getExecutionAdmissionGate()?.isClosed(), true)
      release.resolve()
      await starting
      assert.equal((await closing).ok, true)
      assert.equal(runtime.server.listening, false)
      assert.deepEqual(events, [])
    } finally {
      release.resolve()
      await runtime.close('cleanup')
    }
  })

  it('drains during initialization and preserves domain-before-transport cleanup', async () => {
    const entered = deferred()
    const release = deferred()
    const events: string[] = []
    const messages: string[] = []
    const runtime = createServer({
      signalingGateway: stubGateway(events),
      initializeRuntime: async ({ lifecycle }) => {
        assert.ok(lifecycle)
        lifecycle.register({ name: 'fixture-domain', close: () => { events.push('domain-closed') } })
        entered.resolve()
        await release.promise
      },
      logger: { ...silentLogger, log(message) { messages.push(message) } }
    })
    const controller = installShutdownHandlers(runtime, {
      logger: silentLogger,
      signals: [],
      exit: code => { events.push(`exit-${code}`) }
    })
    const starting = runtime.start()
    await entered.promise
    try {
      const closing = controller.shutdown('SIGTERM')
      assert.equal(getExecutionAdmissionGate()?.isClosed(), true)
      assert.equal(runtime.lifecycle.getState(), 'draining')
      assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/health`)).status, 200)
      assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/readiness`)).status, 503)
      release.resolve()
      await starting
      assert.equal((await closing)?.ok, true)
      assert.equal(runtime.server.listening, false)
      assert.deepEqual(events, ['gateway-attached', 'domain-closed', 'gateway-closed', 'exit-0'])
      assert.ok(!messages.includes('服务器运行在:'))
    } finally {
      release.resolve()
      await runtime.close('cleanup')
      controller.dispose()
    }
  })

  it('closes HTTP even if the signaling gateway close throws', async () => {
    const runtime = createServer({
      signalingGateway: stubGateway([], () => { throw new Error('fixture gateway close failure') })
    })
    await runtime.start()
    const summary = await runtime.close('gateway-failure')
    assert.equal(summary.ok, false)
    assert.equal(runtime.server.listening, false)
    assert.equal(summary.steps.find(step => step.name === 'http-transport')?.status, 'failed')
    assert.equal(summary.steps.find(step => step.name === 'webrtc-preview')?.status, 'closed')
  })

  it('handles SIGTERM received by a child process while startup is pending', async () => {
    const entry = new URL('../server.ts', import.meta.url).href
    const source = `import { createLaPlumaServer, installShutdownHandlers } from ${JSON.stringify(entry)};
const runtime = createLaPlumaServer({
  env: {}, host: '127.0.0.1', port: 0,
  logger: { log() {}, warn() {}, error() {} },
  initializeRunStore: async () => (${JSON.stringify(runStoreSummary)}),
  initializeRuntime: async ({ lifecycle }) => {
    lifecycle.register({ name: 'fixture-domain', close() { process.stdout.write('domain-closed\\n'); } });
    const interrupted = new Promise(resolve => process.once('SIGTERM', resolve));
    process.stdout.write('initializing\\n');
    await interrupted;
  },
  executionShutdownOptions: { runtime: {
    listActiveRuns: () => [], isDeviceTaskRunning: () => false,
    isScheduleRunning: () => false, flushRunStore: async () => {}
  } }
});
installShutdownHandlers(runtime);
await runtime.start();`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let signaled = false
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`startup shutdown timed out: ${stdout} ${stderr}`))
      }, 10_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        if (!signaled && stdout.includes('initializing\n')) {
          signaled = true
          child.kill('SIGTERM')
        }
      })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr })
      })
    })
    assert.equal(result.signal, null)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /initializing\ndomain-closed\n/)
    assert.equal(result.stderr, '')
  })
})
