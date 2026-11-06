import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execDynamicTask } from '../maaExecutionService.ts'
import type { MaaDynamicTaskRuntime } from '../maaExecutionService.ts'
import type { MaaCommandOutcome, MaaSettledHandler } from '../maaProcessService.ts'
import { MaaExecutionBusyError } from '../executionCoordinatorService.ts'
import { parse } from '@iarna/toml'

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
    resolveClientType: async () => 'Official',
    mkdir: async (path, options) => { events.push(['mkdir', path, options]) },
    writeFile: async (path, content) => { events.push(['write', path, content]) },
    removeDirectory: async (path, options) => { events.push(['removeDirectory', path, options]) },
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

function findTaskFileWrite(events: RuntimeEvent[]): RuntimeEvent {
  const event = events.find(item => item[0] === 'write' && String(item[1]).endsWith('task.toml'))
  assert.ok(event)
  return event
}

describe('dynamic task lifecycle', () => {
  it('serializes nested operator targets and theme candidates as native TOML values', async () => {
    const plans = [{ role: 'Warrior', name: '陈', elite: 2, skill_level: 7, skill_mastery: [0, 3, 0] }]
    for (const config of [
      { name: '游戏内培养', type: 'OperProgress', params: { plans } },
      { name: '主题更换', type: 'SwitchTheme', params: { themes: ['默认', '简约'] } }
    ]) {
      const { events, runtime } = createRuntime()
      runtime.createLogCheckpoint = async () => null
      runtime.readLogSince = async () => ''
      await execDynamicTask('game-task', config, config.name, 'automation', true, false, runtime)
      const taskFile = findTaskFileWrite(events)
      const decoded = parse(String(taskFile[2]))
      assert.deepEqual(decoded.tasks, [config])
    }
  })

  it('writes the connected profile client type into the generated task file', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'YoStarEN'
    await execDynamicTask('award', { name: '领取奖励', type: 'Award', params: {} }, '领取奖励', 'agent', true, false, runtime)
    const taskFile = findTaskFileWrite(events)
    const decoded = parse(String(taskFile[2]))
    assert.equal(decoded.client_type, 'YoStarEN')
  })


  it('prefers an explicit client type override for the generated task file', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'YoStarEN'
    runtime.clientType = 'Bilibili'
    await execDynamicTask(
      'startup',
      { name: '启动游戏', type: 'StartUp', params: { start_game_enabled: false } },
      '启动游戏',
      'automation',
      true,
      false,
      runtime
    )
    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.equal(decoded.client_type, 'Bilibili')
    assert.deepEqual(decoded.tasks, [{
      name: '启动游戏',
      type: 'StartUp',
      params: { start_game_enabled: false }
    }])
  });


  it('uses the task config client type when no explicit override is provided', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'YoStarEN'
    await execDynamicTask(
      'startup',
      { name: '启动游戏', type: 'StartUp', params: { start_game_enabled: false, client_type: 'YoStarJP' } },
      '启动游戏',
      'automation',
      true,
      false,
      runtime
    )
    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.equal(decoded.client_type, 'YoStarJP')
  });

  it('reads only the execution checkpoint and rejects a partial operator failure despite CLI success', async () => {
    const { runtime } = createRuntime()
    const checkpoint = { logPath: '/virtual/asst.log', size: 120 }
    runtime.createLogCheckpoint = async () => checkpoint
    runtime.readLogSince = async requested => {
      assert.deepEqual(requested, checkpoint)
      return 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","what":"OperProgressSummary","details":{"success":1,"failed":1,"skipped":0}}'
    }
    await assert.rejects(
      execDynamicTask('operprogress', { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', elite: 2 }] } }, '培养', 'automation', true, false, runtime),
      error => {
        assert.ok(error instanceof Error && 'code' in error && 'details' in error)
        assert.equal(error.code, 'AGENT_GAME_TASK_FAILED')
        assert.deepEqual((error.details as { actions: Array<{ status: string; failedCount: number }> }).actions.map(action => [action.status, action.failedCount]), [['failed', 1]])
        return true
      }
    )
  })

  it('retains skipped and unconfirmed outcomes in the returned actions', async () => {
    for (const [logOutput, status, observed] of [
      ['Assistant::append_callback | SubTaskExtraInfo {"taskchain":"SwitchTheme","what":"SwitchThemeSkipped"}', 'skipped', true],
      ['', 'success', false]
    ] as const) {
      const { runtime } = createRuntime()
      runtime.createLogCheckpoint = async () => null
      runtime.readLogSince = async () => logOutput
      const result = await execDynamicTask('switchtheme', { name: '主题', type: 'SwitchTheme', params: { themes: [] } }, '主题', 'automation', true, false, runtime)
      assert.ok('actions' in result && result.actions)
      assert.equal(result.actions[0].status, status)
      assert.equal(result.actions[0].observed, observed)
    }
  })

  it('settles a background game failure through the existing lifecycle after the process exits', async () => {
    const { events, runtime, getSettled } = createRuntime({ background: true })
    runtime.createLogCheckpoint = async () => null
    runtime.readLogSince = async () => 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","what":"OperProgressSummary","details":{"success":0,"failed":1,"skipped":0}}'
    const outcomes: MaaCommandOutcome[] = []
    runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }
    await execDynamicTask('operprogress', { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', elite: 2 }] } }, '培养', 'automation', false, false, runtime)
    assert.equal(outcomes.length, 0)
    assert.equal(events.some(event => event[0] === 'release'), false)
    const settle = getSettled()
    assert.ok(settle)
    await settle({ ok: true, stopped: false, result: { command: 'run', stdout: '', stderr: '', exitCode: 0, signal: null }, error: null })
    assert.equal(outcomes[0].ok, false)
    assert.equal(outcomes[0].error?.code, 'AGENT_GAME_TASK_FAILED')
    assert.equal(events.at(-1)?.[0], 'release')
  })

  it('keeps log boundary failures unconfirmed while allowing the task process to finish', async () => {
    const { runtime } = createRuntime()
    runtime.createLogCheckpoint = async () => { throw new Error('log unavailable') }
    runtime.readLogSince = async () => { throw new Error('log unavailable') }
    const result = await execDynamicTask('switchtheme', { name: '主题', type: 'SwitchTheme', params: { themes: ['默认'] } }, '主题', 'automation', true, false, runtime)
    assert.ok('actions' in result && result.actions)
    assert.equal(result.actions[0].observed, false)
    assert.match(result.actions[0].message, /游戏结果未确认/)
  })

  it('preserves nonzero process diagnostics and never parses a stopped game task as completed', async () => {
    for (const stopped of [false, true]) {
      const { runtime, getSettled } = createRuntime({ background: true })
      runtime.createLogCheckpoint = async () => null
      let logRead = false
      runtime.readLogSince = async () => {
        logRead = true
        return 'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","what":"OperProgressSummary","details":{"success":0,"failed":1,"skipped":0}}'
      }
      const outcomes: MaaCommandOutcome[] = []
      runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }
      await execDynamicTask('operprogress', { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', elite: 2 }] } }, '培养', 'automation', false, false, runtime)
      const settle = getSettled()
      assert.ok(settle)
      const error = Object.assign(new Error('Core failed'), { code: 'CORE_PROCESS_FAILED', exitCode: 3 })
      await settle({ ok: false, stopped, result: { command: 'run', stdout: '', stderr: 'Core failed', exitCode: 3, signal: null }, error })
      assert.equal(outcomes[0].ok, false)
      assert.equal(outcomes[0].stopped, stopped)
      assert.equal(outcomes[0].error?.code, 'CORE_PROCESS_FAILED')
      assert.equal(outcomes[0].error?.exitCode, 3)
      assert.equal(logRead, !stopped)
    }
  })

  it('locks before writing, uses a unique task directory, and removes it after a foreground run', async () => {
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
    const taskFile = findTaskFileWrite(events)
    const executeArgs = eventArgs(events.find(event => event[0] === 'execute'))
    assert.match(String(executeArgs[0]), /^la-pluma-task-award-nonce_1[\\/]task$/)
    assert.equal(executeArgs[1], '--batch')
    assert.match(String(taskFile[1]), /[\\/]tasks[\\/]la-pluma-task-award-nonce_1[\\/]task\.toml$/)
    assert.match(String(taskFile[2]), /type = "Award"/)
    assert.deepEqual(events.slice(-2).map(event => event[0]), ['removeDirectory', 'release'])
  })

  it('requests batch mode after the task path and keeps user resource ordering', async () => {
    const { events, runtime } = createRuntime()
    await execDynamicTask(
      'award',
      { name: '领取奖励', type: 'Award', params: {} },
      '领取奖励',
      'agent',
      true,
      true,
      runtime
    )

    const executeArgs = eventArgs(events.find(event => event[0] === 'execute'))
    assert.match(String(executeArgs[0]), /^la-pluma-task-award-nonce_1[\\/]task$/)
    assert.equal(executeArgs[1], '--user-resource')
    assert.equal(executeArgs[2], '--batch')
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

    assert.equal(events.some(event => event[0] === 'removeDirectory'), false)
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
    assert.deepEqual(events.slice(-3).map(event => event[0]), ['removeDirectory', 'release', 'lifecycle'])
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
    const taskDirs = events
      .filter(event => event[0] === 'write' && String(event[1]).endsWith('task.toml'))
      .map(event => String(event[1]).replace(/[\\/][^\\/]+$/, ''))
    assert.equal(new Set(taskDirs).size, 2)
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
