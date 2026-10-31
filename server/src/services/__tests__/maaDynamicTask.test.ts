import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execDynamicTask } from '../maaExecutionService.ts'
import type { MaaDynamicTaskRuntime } from '../maaExecutionService.ts'
import type { MaaCommandOutcome, MaaSettledHandler } from '../maaProcessService.ts'
import { MaaExecutionBusyError } from '../executionCoordinatorService.ts'

type RuntimeEvent = [string, ...unknown[]]

interface RuntimeHarness {
  events: RuntimeEvent[]
  runtime: MaaDynamicTaskRuntime
  getSettled(): MaaSettledHandler | null
}

function createRuntime({ background = false }: { background?: boolean } = {}): RuntimeHarness {
  const events: RuntimeEvent[] = []
  let settled: MaaSettledHandler | null = null
  let nonce = 0
  const runtime: MaaDynamicTaskRuntime = {
    acquireExecutionLease: async owner => {
      events.push(['acquire', owner])
      return { release: async () => { events.push(['release']) } }
    },
    getConfigDir: async () => '/virtual/config',
    mkdir: async path => { events.push(['mkdir', path]) },
    writeFile: async (path, content) => { events.push(['write', path, content]) },
    unlink: async path => { events.push(['unlink', path]) },
    createNonce: () => `nonce_${++nonce}`,
    executeCommand: async (command, args, taskName, taskType, waitForCompletion, silent, onSettled) => {
      events.push(['execute', command, [...args], taskName, taskType, waitForCompletion, silent])
      settled = onSettled
      return background
        ? { stdout: '', stderr: '', command: 'run', message: '任务已在后台启动' }
        : { stdout: 'ok', stderr: '', command: 'run' }
    }
  }
  return { events, runtime, getSettled: () => settled }
}

function eventArgs(event: RuntimeEvent | undefined): unknown[] {
  assert.ok(event)
  const args = event[2]
  assert.ok(Array.isArray(args))
  return args
}

describe('dynamic task lifecycle', () => {
  it('locks before writing, uses a unique task id, and removes the file after a foreground run', async () => {
    const { events, runtime } = createRuntime()
    const result = await execDynamicTask(
      'award',
      { name: '领取奖励', type: 'Award', params: { award: true } },
      '领取奖励',
      'agent',
      true,
      false,
      runtime
    )

    assert.deepEqual(result, { stdout: 'ok', stderr: '', command: 'run' })
    assert.equal(events[0][0], 'acquire')
    const writeEvent = events.find(event => event[0] === 'write')
    assert.ok(writeEvent)
    const runId = String(eventArgs(events.find(event => event[0] === 'execute'))[0])
    assert.equal(runId, 'award_temp_nonce_1')
    assert.ok(String(writeEvent[1]).endsWith(`/tasks/${runId}.toml`))
    assert.match(String(writeEvent[2]), /type = "Award"/)
    assert.deepEqual(events.slice(-2).map(event => event[0]), ['unlink', 'release'])
  })

  it('keeps the task file and lease until a background process settles', async () => {
    const { events, runtime, getSettled } = createRuntime({ background: true })
    const lifecycleGate: { release: (() => void) | null } = { release: null }
    let lifecycleFinished = false
    runtime.lifecycle = {
      onSettled: async outcome => {
        await new Promise<void>(resolve => { lifecycleGate.release = resolve })
        events.push(['lifecycle', outcome])
        lifecycleFinished = true
      }
    }
    await execDynamicTask('fight', { name: '理智作战', type: 'Fight', params: { stage: '1-7' } }, '理智作战', 'agent', false, false, runtime)

    assert.equal(events.some(event => event[0] === 'unlink'), false)
    assert.equal(events.some(event => event[0] === 'release'), false)
    const settledHandler = getSettled()
    assert.equal(typeof settledHandler, 'function')
    assert.ok(settledHandler)

    const outcome: MaaCommandOutcome = {
      ok: true,
      stopped: false,
      result: { stdout: 'done', stderr: '', command: 'run', exitCode: 0, signal: null },
      error: null
    }
    const settlement = settledHandler(outcome)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lifecycleFinished, false)
    const releaseLifecycle = lifecycleGate.release
    assert.ok(releaseLifecycle)
    assert.equal(typeof releaseLifecycle, 'function')

    releaseLifecycle()
    await settlement
    assert.deepEqual(events.slice(-3).map(event => event[0]), ['unlink', 'release', 'lifecycle'])
    assert.deepEqual(events.at(-1)?.[1], outcome)
  })

  it('does not collapse concurrent requests onto the same task file', async () => {
    const { events, runtime } = createRuntime()
    await Promise.all([
      execDynamicTask('award', { name: '奖励 A', type: 'Award', params: {} }, '奖励 A', 'agent', true, false, runtime),
      execDynamicTask('award', { name: '奖励 B', type: 'Award', params: {} }, '奖励 B', 'agent', true, false, runtime)
    ])

    const runIds = events
      .filter(event => event[0] === 'execute')
      .map(event => String(eventArgs(event)[0]))
    assert.equal(new Set(runIds).size, 2)
  })

  it('preserves a busy execution error before any task file is written', async () => {
    const busy = new MaaExecutionBusyError({
      pid: null,
      source: 'test',
      taskName: '仓库识别',
      command: 'run',
      startedAt: null
    })
    const { events, runtime } = createRuntime()
    runtime.acquireExecutionLease = async () => { throw busy }

    await assert.rejects(
      execDynamicTask('award', { name: '领取奖励', type: 'Award', params: {} }, '领取奖励', 'agent', true, false, runtime),
      error => {
        assert.ok(error instanceof MaaExecutionBusyError)
        return error === busy && error.statusCode === 409 && error.retryable === true
      }
    )
    assert.equal(events.some(event => event[0] === 'write'), false)
  })
})
