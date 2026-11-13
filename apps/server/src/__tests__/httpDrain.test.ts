import assert from 'node:assert/strict'
import { once } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaServer, installShutdownHandlers } from '../server.ts'
import type { LaPlumaServer } from '../server.ts'

const runtimes: LaPlumaServer[] = []
const silentLogger = { log() {}, warn() {}, error() {} }

function runtimeWithBudget(closeDeadlineMs = 2_000): LaPlumaServer {
  const runtime = createLaPlumaServer({
    env: {}, host: '127.0.0.1', port: 0, closeDeadlineMs,
    initializeRunStore: async () => ({ filePath: '/tmp/test-agent-runs.json', restoredRuns: 0, interruptedRuns: 0, prunedRuns: 0 }),
    initializeRuntime: async () => {},
    executionShutdownOptions: { runtime: {
      listActiveRuns: () => [], isDeviceTaskRunning: () => false,
      isScheduleRunning: () => false, flushRunStore: async () => {}
    } },
    logger: silentLogger
  })
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.server.closeAllConnections()
    await runtime.close('cleanup')
  }
})

describe('HTTP shutdown drain', () => {
  it('stops accepting connections and lets an in-flight streamed response finish', async () => {
    const runtime = runtimeWithBudget()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    runtime.app.get('/fixture/stream', async (_req, res) => {
      res.write('first chunk\n')
      entered.resolve()
      await release.promise
      res.end('last chunk\n')
    })
    await runtime.start()
    const origin = `http://127.0.0.1:${runtime.port}`
    const response = await fetch(`${origin}/fixture/stream`)
    const body = response.text()
    await entered.promise
    try {
      let finishedClosing = false
      const closing = runtime.close('drain-response').then(summary => { finishedClosing = true; return summary })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(runtime.server.listening, false)
      assert.equal(finishedClosing, false)
      await assert.rejects(fetch(`${origin}/health`))

      release.resolve()
      assert.equal(await body, 'first chunk\nlast chunk\n')
      const summary = await closing
      assert.equal(summary.ok, true, JSON.stringify(summary))
      assert.equal(summary.steps.find(step => step.name === 'http-transport')?.status, 'closed')
    } finally {
      release.resolve()
      await body.catch(() => undefined)
    }
  })

  it('forces a stalled response closed when its budget expires and exits non-zero', async () => {
    const runtime = runtimeWithBudget(180)
    runtime.app.get('/fixture/stalled', (_req, res) => { res.write('unfinished chunk\n') })
    await runtime.start()
    const response = await fetch(`http://127.0.0.1:${runtime.port}/fixture/stalled`)
    const body = response.text().then(() => null, (error: unknown) => error)
    const transportClosed = once(runtime.server, 'close')
    const exits: number[] = []
    const controller = installShutdownHandlers(runtime, {
      signals: [], logger: silentLogger, exit: code => { exits.push(code) }
    })
    try {
      const began = Date.now()
      const summary = await controller.shutdown('SIGTERM')
      await transportClosed
      assert.ok(Date.now() - began < 700)
      assert.equal(summary?.ok, false)
      assert.equal(summary?.steps?.find(step => step.name === 'http-transport')?.status, 'timeout')
      assert.deepEqual(exits, [1])
      assert.ok((await body) instanceof Error)
      assert.equal(runtime.server.listening, false)
    } finally {
      controller.dispose()
    }
  })
})
