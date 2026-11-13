import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS, execDynamicTask, execDynamicTasks } from '../maaExecutionService.ts'
import type {
  MaaDynamicTaskRuntime,
  MaaDynamicTaskErrorStep,
  MaaDynamicTasksBackgroundStart,
  MaaDynamicTasksOutput
} from '../maaExecutionService.ts'
import type { MaaCommandOutcome, MaaCommandResult, MaaSettledHandler } from '../maaProcessService.ts'
import { MaaExecutionBusyError } from '../executionCoordinatorService.ts'
import { parse } from '@iarna/toml'

type RuntimeEvent = [string, ...unknown[]]

interface RuntimeHarness {
  events: RuntimeEvent[]
  runtime: MaaDynamicTaskRuntime
  getSettled(): MaaSettledHandler | null
  getSettleds(): MaaSettledHandler[]
}

function createRuntime({ background = false }: { background?: boolean } = {}): RuntimeHarness {
  const events: RuntimeEvent[] = []
  const settledHandlers: MaaSettledHandler[] = []
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
    executeCommand: async (command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle) => {
      await lifecycle?.onBeforeStart?.()
      events.push(['execute', command, [...args], taskName, taskType, waitForCompletion, silent])
      settled = onSettled
      if (onSettled) settledHandlers.push(onSettled)
      return background
        ? { stdout: '', stderr: '', command: 'run', message: '任务已在后台启动' }
        : { stdout: 'ok', stderr: '', command: 'run' }
    }
  }
  return { events, runtime, getSettled: () => settled, getSettleds: () => settledHandlers }
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

function errorField(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined
}

describe('dynamic task lifecycle', () => {
  it('writes the authoritative Core spelling for a migrated legacy roguelike target', async () => {
    const { events, runtime } = createRuntime()
    await execDynamicTask('roguelike-legacy', {
      name: '集成战略',
      type: 'Roguelike',
      params: { theme: 'JieGarden', mode: 20001, find_play_time_target: 2 }
    }, '集成战略', 'automation', true, false, runtime)

    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.deepEqual(decoded.tasks, [{
      name: '集成战略',
      type: 'Roguelike',
      params: { theme: 'JieGarden', mode: 20001, find_playTime_target: 2 }
    }])
  })

  it('rejects conflicting legacy and authoritative roguelike targets before writing the task file', async () => {
    const { events, runtime } = createRuntime()
    await assert.rejects(
      execDynamicTask('roguelike-conflict', {
        name: '集成战略',
        type: 'Roguelike',
        params: {
          theme: 'JieGarden',
          mode: 20001,
          find_play_time_target: 1,
          find_playTime_target: 2
        }
      }, '集成战略', 'automation', true, false, runtime),
      error => errorField(error, 'statusCode') === 400
    )
    assert.equal(events.some(event => event[0] === 'write' && String(event[1]).endsWith('task.toml')), false)
  })

  it('rejects Tales mode 1 without crafting tools before writing the task file', async () => {
    const { events, runtime } = createRuntime()
    await assert.rejects(
      execDynamicTask('reclamation', {
        name: '生息演算',
        type: 'Reclamation',
        params: { theme: 'Tales', mode: 1 }
      }, '生息演算', 'automation', true, false, runtime),
      error => {
        assert.equal(errorField(error, 'statusCode'), 400)
        assert.match(String(errorField(error, 'message')), /tools_to_craft/)
        return true
      }
    )
    assert.equal(events.some(event => event[0] === 'write' && String(event[1]).endsWith('task.toml')), false)
    assert.equal(events.some(event => event[0] === 'execute'), false)
  })

  it('serializes the crafting configuration MaaCore requires for Tales mode 1', async () => {
    const { events, runtime } = createRuntime()
    const params = { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], num_craft_batches: 16 }
    await execDynamicTask(
      'reclamation',
      { name: '生息演算', type: 'Reclamation', params },
      '生息演算',
      'automation',
      true,
      false,
      runtime
    )
    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.deepEqual(decoded.tasks, [{ name: '生息演算', type: 'Reclamation', params }])
  })

  it('rejects a variant that empties the required crafting tools', async () => {
    const { events, runtime } = createRuntime()
    await assert.rejects(
      execDynamicTask('reclamation-variant', {
        name: '生息演算',
        type: 'Reclamation',
        params: { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'] },
        variants: [{ params: { tools_to_craft: [] } }]
      }, '生息演算', 'automation', true, false, runtime),
      error => {
        assert.equal(errorField(error, 'statusCode'), 400)
        assert.match(String(errorField(error, 'message')), /tools_to_craft/)
        return true
      }
    )
    assert.equal(events.some(event => event[0] === 'write' && String(event[1]).endsWith('task.toml')), false)
  })

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
    let resolved = 0
    runtime.resolveClientType = async () => {
      resolved += 1
      return 'YoStarEN'
    }
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
    assert.equal(resolved, 0)
  });


  it('falls back to the connection profile when the runtime client type is blank', async () => {
    for (const blank of ['', '   ']) {
      const { events, runtime } = createRuntime()
      runtime.resolveClientType = async () => 'YoStarEN'
      runtime.clientType = blank
      await execDynamicTask('award', { name: '领取奖励', type: 'Award', params: {} }, '领取奖励', 'agent', true, false, runtime)
      assert.equal(parse(String(findTaskFileWrite(events)[2])).client_type, 'YoStarEN')
    }
  })


  it('falls back to the connection profile when the task config client type is blank', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'YoStarEN'
    await execDynamicTask(
      'startup',
      { name: '启动游戏', type: 'StartUp', params: { start_game_enabled: false, client_type: '' } },
      '启动游戏',
      'automation',
      true,
      false,
      runtime
    )
    assert.equal(parse(String(findTaskFileWrite(events)[2])).client_type, 'YoStarEN')
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

  it('rejects a variant client type that the run-level client type would silently override', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'Official'
    await assert.rejects(
      execDynamicTask('startup-variant', {
        name: '启动游戏',
        type: 'StartUp',
        params: { start_game_enabled: false },
        variants: [{ params: { client_type: 'Bilibili' } }]
      }, '启动游戏', 'automation', true, false, runtime),
      error => {
        assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_TASK_CONFIG_INVALID')
        assert.equal(errorField(error, 'statusCode'), 400)
        const message = String(errorField(error, 'message'))
        assert.match(message, /variants\[0\]\.params\.client_type/)
        assert.match(message, /Bilibili/)
        assert.match(message, /Official/)
        return true
      }
    )
    assert.equal(events.some(event => event[0] === 'write' && String(event[1]).endsWith('task.toml')), false)
    assert.equal(events.some(event => event[0] === 'execute'), false)
  })

  it('keeps a variant client type that matches the run-level client type', async () => {
    const { events, runtime } = createRuntime()
    runtime.resolveClientType = async () => 'Bilibili'
    await execDynamicTask('startup-variant', {
      name: '启动游戏',
      type: 'StartUp',
      params: { start_game_enabled: false },
      variants: [{ params: { client_type: 'Bilibili' } }]
    }, '启动游戏', 'automation', true, false, runtime)
    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.equal(decoded.client_type, 'Bilibili')
    assert.deepEqual(decoded.tasks, [{
      name: '启动游戏',
      type: 'StartUp',
      params: { start_game_enabled: false },
      variants: [{ params: { client_type: 'Bilibili' } }]
    }])
  })

  it('rejects a task client type that conflicts with an explicit runtime client type', async () => {
    const { events, runtime } = createRuntime()
    runtime.clientType = 'Bilibili'
    await assert.rejects(
      execDynamicTask('startup-conflict', {
        name: '启动游戏',
        type: 'StartUp',
        params: { start_game_enabled: false, client_type: 'Official' }
      }, '启动游戏', 'automation', true, false, runtime),
      error => {
        assert.equal(errorField(error, 'statusCode'), 400)
        assert.match(String(errorField(error, 'message')), /StartUp\.params\.client_type/)
        return true
      }
    )
    assert.equal(events.some(event => event[0] === 'write' && String(event[1]).endsWith('task.toml')), false)
  })

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

  it('locks before writing, requests batch mode with user resource ordering, and cleans up after a foreground run', async () => {
    const { events, runtime } = createRuntime()
    const result = await execDynamicTask(
      'award',
      { name: '领取奖励', type: 'Award', params: { award: true } },
      '领取奖励',
      'agent',
      true,
      true,
      runtime
    )

    assert.deepEqual(result, { stdout: 'ok', stderr: '', command: 'run' })
    assert.equal(events[0][0], 'acquire')
    const taskFile = findTaskFileWrite(events)
    const executeArgs = eventArgs(events.find(event => event[0] === 'execute'))
    assert.match(String(executeArgs[0]), /^la-pluma-task-award-nonce_1[\\/]task$/)
    assert.equal(executeArgs[1], '--user-resource')
    assert.equal(executeArgs[2], '--batch')
    assert.match(String(taskFile[1]), /[\\/]tasks[\\/]la-pluma-task-award-nonce_1[\\/]task\.toml$/)
    assert.match(String(taskFile[2]), /type = "Award"/)
    assert.deepEqual(events.slice(-2).map(event => event[0]), ['removeDirectory', 'release'])
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('condition was not met')
}

function backgroundOutcome(stdout: string): MaaCommandOutcome {
  return {
    ok: true,
    stopped: false,
    result: { stdout, stderr: '', command: 'run', exitCode: 0, signal: null },
    error: null
  }
}

describe('dynamic task variants', () => {
  it('serializes strategy and nested variants into native TOML', async () => {
    const { events, runtime } = createRuntime()
    const variants = [
      { condition: { type: 'Time', start: '18:00:00', end: '04:00:00' }, params: { plan_index: 0 } },
      { condition: { type: 'And', conditions: [{ type: 'Weekday', weekdays: ['Mon', 'Thu'] }] }, params: { plan_index: 1 } },
      { params: { plan_index: 2 } }
    ]
    await execDynamicTask(
      'infrast',
      { name: '基建换班', type: 'Infrast', params: { mode: 10000 }, strategy: 'merge', variants },
      '基建换班',
      'automation',
      true,
      false,
      runtime
    )

    const decoded = parse(String(findTaskFileWrite(events)[2]))
    assert.deepEqual(decoded.tasks, [{
      name: '基建换班',
      type: 'Infrast',
      params: { mode: 10000 },
      strategy: 'merge',
      variants
    }])
  })
})

describe('dynamic multi-task lifecycle', () => {
  it('runs tasks in array order under one lease and archives every result by index', async () => {
    const { events, runtime } = createRuntime()
    const result = await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} },
        { name: '基建换班', type: 'Infrast', params: {}, variants: [{ params: { plan_index: 0 } }] }
      ],
      '多任务',
      'automation',
      true,
      false,
      runtime
    ) as MaaDynamicTasksOutput

    assert.equal(result.stopped, false)
    assert.deepEqual(result.tasks.map(step => [step.index, step.name, step.status]), [
      [0, '领取奖励', 'success'],
      [1, '仓库识别', 'success'],
      [2, '基建换班', 'success']
    ])
    assert.equal(events.filter(event => event[0] === 'acquire').length, 1)
    assert.equal(events.filter(event => event[0] === 'release').length, 1)
    const executes = events.filter(event => event[0] === 'execute')
    assert.equal(executes.length, 3)
    assert.ok(executes.every(event => event[5] === true))
    assert.match(String(executes[1][3]), /2\/3/)
    assert.equal(events.filter(event => event[0] === 'removeDirectory').length, 3)
  })

  it('keeps succeeded results and continues after a middle task failure', async () => {
    const { events, runtime } = createRuntime()
    runtime.executeCommand = async (command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle) => {
      await lifecycle?.onBeforeStart?.()
      events.push(['execute', command, [...args], taskName, taskType, waitForCompletion, silent])
      if (String(taskName).includes('(2/3)')) {
        throw Object.assign(new Error('第二个任务失败'), {
          code: 'CORE_PROCESS_FAILED',
          statusCode: 500,
          stdout: 'failed-out',
          stderr: 'failed-err'
        })
      }
      return { stdout: `ok-${String(taskName)}`, stderr: '', command: 'run' }
    }

    await assert.rejects(
      execDynamicTasks(
        'multi',
        [
          { name: '领取奖励', type: 'Award', params: {} },
          { name: '仓库识别', type: 'Depot', params: {} },
          { name: '基建换班', type: 'Infrast', params: {} }
        ],
        '多任务',
        'automation',
        true,
        false,
        runtime
      ),
      error => {
        assert.ok(error instanceof Error)
        const failure = error as Error & {
          code?: string
          details?: { taskIndexes?: number[]; causeCode?: string; tasks?: MaaDynamicTasksOutput['tasks'] }
        }
        assert.equal(failure.code, 'AGENT_DYNAMIC_TASKS_FAILED')
        assert.deepEqual(failure.details?.taskIndexes, [1])
        assert.equal(failure.details?.causeCode, 'CORE_PROCESS_FAILED')
        assert.deepEqual(failure.details?.tasks?.map(step => step.status), ['success', 'failed', 'success'])
        assert.equal(failure.details?.tasks?.[0].stdout, 'ok-多任务 (1/3)')
        assert.equal(failure.details?.tasks?.[1].stdout, 'failed-out')
        assert.equal(failure.details?.tasks?.[2].status, 'success')
        return true
      }
    )
    assert.equal(events.filter(event => event[0] === 'execute').length, 3)
  })

  it('bounds per-task stdout and stderr in the aggregate failure details', async () => {
    const longOutput = 'x'.repeat(20_000)
    const { runtime } = createRuntime()
    runtime.executeCommand = async (command, args, taskName) => {
      if (String(taskName).includes('(2/3)')) {
        throw Object.assign(new Error('第二个任务失败'), {
          code: 'CORE_PROCESS_FAILED',
          statusCode: 500,
          stdout: longOutput,
          stderr: `err-${longOutput}`
        })
      }
      return { stdout: `ok-${String(taskName)}`, stderr: '', command: 'run' }
    }

    await assert.rejects(
      execDynamicTasks(
        'multi',
        [
          { name: '领取奖励', type: 'Award', params: {} },
          { name: '仓库识别', type: 'Depot', params: {} },
          { name: '基建换班', type: 'Infrast', params: {} }
        ],
        '多任务',
        'automation',
        true,
        false,
        runtime
      ),
      error => {
        assert.ok(error instanceof Error)
        const failure = error as Error & {
          details?: { tasks?: Array<MaaDynamicTaskErrorStep> }
        }
        const tasks = failure.details?.tasks
        assert.ok(tasks)
        assert.deepEqual(tasks.map(step => step.status), ['success', 'failed', 'success'])
        assert.equal(tasks[0].stdout, 'ok-多任务 (1/3)')
        assert.equal(tasks[0].stdoutTruncated, undefined)
        assert.equal(tasks[0].stderrTruncated, undefined)
        assert.equal(tasks[1].stdout.length, MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS)
        assert.equal(tasks[1].stdoutTruncated, true)
        assert.equal(tasks[1].stderr.length, MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS)
        assert.equal(tasks[1].stderrTruncated, true)
        assert.match(tasks[1].message, /第二个任务失败/)
        assert.equal(tasks[1].index, 1)
        assert.equal(tasks[2].stdoutTruncated, undefined)
        return true
      }
    )
  })

  it('stops the current task, keeps finished results and never starts the rest', async () => {
    const { events, runtime } = createRuntime()
    runtime.executeCommand = async (command, args, taskName, taskType, waitForCompletion, silent, onSettled, lifecycle) => {
      await lifecycle?.onBeforeStart?.()
      events.push(['execute', command, [...args], taskName, taskType, waitForCompletion, silent])
      if (String(taskName).includes('(2/3)')) {
        throw Object.assign(new Error('任务已停止'), {
          stopped: true,
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: 'SIGTERM'
        })
      }
      return { stdout: 'ok', stderr: '', command: 'run' }
    }

    const result = await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} },
        { name: '基建换班', type: 'Infrast', params: {} }
      ],
      '多任务',
      'automation',
      true,
      false,
      runtime
    ) as MaaDynamicTasksOutput

    assert.equal(result.stopped, true)
    assert.deepEqual(result.tasks.map(step => step.status), ['success', 'stopped', 'pending'])
    assert.equal(result.tasks[2].message, '任务已停止，未执行该任务')
    assert.equal(events.filter(event => event[0] === 'execute').length, 2)
  })

  it('treats a pre-start stop gate as stopping before the next task runs', async () => {
    const { events, runtime } = createRuntime()
    let started = 0
    runtime.lifecycle = {
      onBeforeStart: () => {
        started += 1
        if (started === 2) {
          throw Object.assign(new Error('执行在开始前已被停止'), {
            stopped: true,
            code: 'AGENT_RUN_STOPPED_BEFORE_START',
            statusCode: 409
          })
        }
      }
    }

    const result = await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} },
        { name: '基建换班', type: 'Infrast', params: {} }
      ],
      '多任务',
      'automation',
      true,
      false,
      runtime
    ) as MaaDynamicTasksOutput

    assert.equal(result.stopped, true)
    assert.deepEqual(result.tasks.map(step => step.status), ['success', 'pending', 'pending'])
    assert.equal(events.filter(event => event[0] === 'execute').length, 1)
  })

  it('chains background tasks and settles the run once after the last task', async () => {
    const { events, runtime, getSettleds } = createRuntime({ background: true })
    const outcomes: MaaCommandOutcome[] = []
    runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }

    const accepted = await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} }
      ],
      '多任务',
      'automation',
      false,
      false,
      runtime
    ) as MaaDynamicTasksBackgroundStart

    assert.deepEqual(accepted.tasks.map(step => step.status), ['running', 'pending'])
    assert.equal(getSettleds().length, 1)
    await getSettleds()[0](backgroundOutcome('first-out'))
    await waitFor(() => getSettleds().length === 2)
    await getSettleds()[1](backgroundOutcome('second-out'))
    await waitFor(() => outcomes.length === 1)

    assert.equal(outcomes[0].ok, true)
    const final = outcomes[0].result as MaaCommandResult & MaaDynamicTasksOutput
    assert.deepEqual(final.tasks.map(step => step.status), ['success', 'success'])
    assert.equal(final.stdout, 'first-out\nsecond-out')
    assert.equal(events.filter(event => event[0] === 'removeDirectory').length, 2)
    assert.equal(events.filter(event => event[0] === 'release').length, 1)
  })

  it('continues background tasks after a failure and reports the aggregate result', async () => {
    const { runtime, getSettleds } = createRuntime({ background: true })
    const outcomes: MaaCommandOutcome[] = []
    runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }

    await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} }
      ],
      '多任务',
      'automation',
      false,
      false,
      runtime
    ) as MaaDynamicTasksBackgroundStart

    await getSettleds()[0]({
      ok: false,
      stopped: false,
      result: { stdout: 'failed-out', stderr: 'err', command: 'run', exitCode: 3, signal: null },
      error: Object.assign(new Error('后台任务失败'), { code: 'CORE_PROCESS_FAILED', exitCode: 3 })
    })
    await waitFor(() => getSettleds().length === 2)
    await getSettleds()[1](backgroundOutcome('second-out'))
    await waitFor(() => outcomes.length === 1)

    assert.equal(outcomes[0].ok, false)
    assert.equal(outcomes[0].stopped, false)
    assert.equal(outcomes[0].error?.code, 'AGENT_DYNAMIC_TASKS_FAILED')
    const details = outcomes[0].error?.details as { taskIndexes?: number[]; tasks?: MaaDynamicTasksOutput['tasks'] } | undefined
    assert.deepEqual(details?.taskIndexes, [0])
    assert.deepEqual(details?.tasks?.map(step => step.status), ['failed', 'success'])
  })

  it('keeps the full per-task output in the background result while error details stay bounded', async () => {
    const longOutput = 'y'.repeat(20_000)
    const { runtime, getSettleds } = createRuntime({ background: true })
    const outcomes: MaaCommandOutcome[] = []
    runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }

    await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} }
      ],
      '多任务',
      'automation',
      false,
      false,
      runtime
    ) as MaaDynamicTasksBackgroundStart

    await getSettleds()[0]({
      ok: false,
      stopped: false,
      result: { stdout: longOutput, stderr: longOutput, command: 'run', exitCode: 3, signal: null },
      error: Object.assign(new Error('后台任务失败'), { code: 'CORE_PROCESS_FAILED', exitCode: 3 })
    })
    await waitFor(() => getSettleds().length === 2)
    await getSettleds()[1](backgroundOutcome('second-out'))
    await waitFor(() => outcomes.length === 1)

    assert.equal(outcomes[0].ok, false)
    const final = outcomes[0].result as MaaCommandResult & MaaDynamicTasksOutput
    assert.equal(final.tasks[0].stdout, longOutput)
    assert.equal(final.tasks[0].stderr, longOutput)
    assert.equal(final.stdout, `${longOutput}\nsecond-out`)
    const details = outcomes[0].error?.details as {
      tasks?: Array<MaaDynamicTaskErrorStep>
    } | undefined
    assert.equal(details?.tasks?.[0].stdout.length, MAX_DYNAMIC_TASK_ERROR_OUTPUT_CHARS)
    assert.equal(details?.tasks?.[0].stdoutTruncated, true)
    assert.equal(details?.tasks?.[0].stderrTruncated, true)
    assert.equal(details?.tasks?.[1].stdout, 'second-out')
    assert.equal(details?.tasks?.[1].stdoutTruncated, undefined)
  })

  it('stops a background chain when the running task is stopped', async () => {
    const { runtime, getSettleds } = createRuntime({ background: true })
    const outcomes: MaaCommandOutcome[] = []
    runtime.lifecycle = { onSettled: outcome => { outcomes.push(outcome) } }

    await execDynamicTasks(
      'multi',
      [
        { name: '领取奖励', type: 'Award', params: {} },
        { name: '仓库识别', type: 'Depot', params: {} }
      ],
      '多任务',
      'automation',
      false,
      false,
      runtime
    )

    await getSettleds()[0]({
      ok: false,
      stopped: true,
      result: { stdout: '', stderr: '', command: 'run', exitCode: null, signal: 'SIGTERM' },
      error: null
    })
    await waitFor(() => outcomes.length === 1)

    assert.equal(outcomes[0].stopped, true)
    const final = outcomes[0].result as MaaCommandResult & MaaDynamicTasksOutput
    assert.deepEqual(final.tasks.map(step => step.status), ['stopped', 'pending'])
    assert.equal(getSettleds().length, 1)
  })

  it('rejects before starting any task when the stop gate rejects the first background task', async () => {
    const { events, runtime, getSettleds } = createRuntime({ background: true })
    runtime.lifecycle = {
      onBeforeStart: () => {
        throw Object.assign(new Error('执行在开始前已被停止'), {
          stopped: true,
          code: 'AGENT_RUN_STOPPED_BEFORE_START',
          statusCode: 409
        })
      }
    }

    await assert.rejects(
      execDynamicTasks(
        'multi',
        [{ name: '领取奖励', type: 'Award', params: {} }],
        '多任务',
        'automation',
        false,
        false,
        runtime
      ),
      error => {
        assert.ok(error instanceof Error)
        assert.equal((error as Error & { stopped?: boolean }).stopped, true)
        return true
      }
    )
    assert.equal(getSettleds().length, 0)
    assert.equal(events.filter(event => event[0] === 'release').length, 1)
  })
})
