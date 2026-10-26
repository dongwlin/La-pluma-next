import { expect, type Page, type Request, type Route } from '@playwright/test'
import {
  EXTERNAL_IMAGE_HOSTS,
  PLACEHOLDER_PNG_BASE64,
  apiFixtures,
} from '../visual/fixtures'
import { expectNoBrowserErrors, recordBrowserErrors } from '../visual/browser-errors'

export interface ScenarioRequest {
  method: string
  path: string
  body: unknown
}

export interface ScenarioState {
  runState: 'running' | 'stopping' | 'stopped' | 'succeeded'
  runId: string
  operationId: string
  staleRunId: string
  stopCalls: string[]
  submissions: ScenarioRequest[]
  automationConfig: Record<string, unknown>
  automationSaveCalls: ScenarioRequest[]
  scheduleCalls: ScenarioRequest[]
  scheduleFailuresRemaining: number
  operBox: Record<string, unknown>
  trainingQueue: Record<string, unknown>
  plan: Record<string, unknown>
  applyCalls: ScenarioRequest[]
  applyResult: Record<string, unknown>
  requests: ScenarioRequest[]
}

const clone = <T,>(value: T): T => structuredClone(value)

export function ok(data: unknown): { success: true; data: unknown } {
  return { success: true, data }
}

export function failure(message: string, code = 'INTEGRATION_PARTIAL_FAILURE'): Record<string, unknown> {
  return { success: false, error: { code, message, retryable: true } }
}

export function fixturePayload(path: string, method = 'GET'): unknown {
  const actual = path.split('/').filter(Boolean)
  for (const fixture of apiFixtures) {
    if ((fixture.method ?? 'GET') !== method) continue
    const pattern = fixture.path.split('/').filter(Boolean)
    if (pattern.length !== actual.length) continue
    if (pattern.every((part, index) => part.startsWith(':') ? Boolean(actual[index]) : part === actual[index])) {
      return clone(fixture.payload)
    }
  }
  return undefined
}

export function readData(path: string): Record<string, unknown> {
  const envelope = fixturePayload(path) as { data: Record<string, unknown> } | undefined
  if (!envelope?.data) throw new Error(`缺少场景 fixture: ${path}`)
  return envelope.data
}

export function makeRun(state: ScenarioState['runState'], runId = stateRunId, operationId = 'run_daily_flow'): Record<string, unknown> {
  const terminal = state === 'stopped' || state === 'succeeded'
  const activity = operationId === 'run_current_activity_copilots'
  return {
    runId,
    operationId,
    state,
    acceptedAt: '2026-10-24T04:00:00.000Z',
    startedAt: '2026-10-24T04:00:01.000Z',
    ...(terminal ? { finishedAt: '2026-10-24T04:00:02.000Z' } : {}),
    progress: terminal ? undefined : {
      scheduleId: 'manual',
      currentStep: 1,
      totalSteps: 3,
      currentTask: activity ? '活动作业预检' : '理智作战',
      currentTaskId: 'fight-integration',
      shouldStop: state === 'stopping',
      message: state === 'stopping' ? '正在停止跨页场景任务' : activity ? '正在检查活动导航链' : '正在执行跨页场景任务',
    },
    ...(terminal ? {
      result: {
        message: state === 'stopped' ? '跨页场景已终止' : '跨页场景已完成',
        summary: {
          successCount: state === 'succeeded' ? 3 : 1,
          failedCount: 0,
          skippedCount: state === 'stopped' ? 2 : 0,
          durationMs: 12000,
          summaries: [], reports: [], actions: [], errors: [], warnings: [],
          taskResults: [{ taskId: 'fight-integration', task: '理智作战', status: state === 'succeeded' ? 'success' : 'stopped' }],
        },
      },
    } : {}),
    links: {
      self: `/api/agent/runs/${runId}`,
      stop: `/api/agent/actions/stop?runId=${runId}`,
    },
  }
}

const stateRunId = 'run-cross-page-current'

export function makeSnapshot(state: ScenarioState): Record<string, unknown> {
  const base = readData('/agent/runs/current')
  const schedule = base.schedule as Record<string, unknown>
  const occupancy = base.occupancy as Record<string, unknown>
  const run = makeRun(state.runState, state.runId, state.operationId)
  const active = state.runState === 'running' || state.runState === 'stopping'
  return {
    ...base,
    isRunning: active,
    taskName: active ? '跨页场景任务' : null,
    stopRequested: state.runState === 'stopping',
    run: active ? run : null,
    activeRuns: active ? [run] : [],
    lastRun: active ? makeRun('stopped', state.staleRunId) : run,
    schedule: {
      isRunning: active,
      scheduleId: 'manual',
      runId: state.runId,
      currentStep: 1,
      totalSteps: 3,
      currentTask: '理智作战',
      currentTaskId: 'fight-integration',
      shouldStop: state.runState === 'stopping',
      message: active ? '正在执行跨页场景任务' : '跨页场景已结束',
      lastResult: (run.result as Record<string, unknown> | undefined)?.summary ?? schedule.lastResult,
      taskResults: [{ taskId: 'fight-integration', task: '理智作战', status: active ? 'running' : 'stopped' }],
    },
    occupancy: {
      ...occupancy,
      state: active ? 'run' : 'idle',
      runId: active ? state.runId : null,
      runState: active ? state.runState : null,
      sources: active ? ['run', 'task', 'schedule'] : [],
      task: { isRunning: active, taskName: active ? '跨页场景任务' : null, taskType: 'run_daily_flow', stopRequested: state.runState === 'stopping' },
      schedule: { isRunning: active, scheduleId: 'manual', runId: active ? state.runId : null, currentStep: 1, totalSteps: 3, currentTask: active ? '理智作战' : null, shouldStop: state.runState === 'stopping' },
    },
  }
}

function createInitialAutomationConfig(): Record<string, unknown> {
  const config = readData('/agent/config/user/automation-tasks')
  return {
    ...config,
    taskFlow: [
      {
        id: 'startup-integration', commandId: 'startup', name: '启动游戏',
        description: '启动游戏并进入主界面', defaultParams: { clientType: 'Official' },
        params: { clientType: 'Official', accountName: '' }, enabled: true,
      },
      {
        id: 'fight-integration', commandId: 'fight', name: '理智作战',
        description: '自动刷关卡消耗理智', defaultParams: { stage: '1-7' },
        params: { stages: [{ stage: '1-7', times: '1' }], medicine: 0, stone: 0, series: '1' }, enabled: true,
      },
      {
        id: 'award-integration', commandId: 'award', name: '领取奖励',
        description: '领取每日奖励', defaultParams: { award: true },
        params: { award: true, mail: true, recruit: true }, enabled: true,
      },
    ],
    schedule: { enabled: true, entries: [{ time: '04:00', enabled: true }, { time: '12:00', enabled: true }] },
  }
}

export function createScenarioState(): ScenarioState {
  const operBox = readData('/agent/data/operbox')
  const queue = readData('/agent/training/queue')
  const plan = {
    queueRevision: 'integration-queue-v1',
    mode: 'current',
    focusOperator: { id: 'char_180_amgoat', name: '艾雅法拉', rarity: 6 },
    operators: [{ id: 'char_180_amgoat', name: '艾雅法拉', rarity: 6, currentElite: 1, targetElite: 2 }],
    stages: [{ stage: 'CE-6', stageName: '龙门币补给', totalTimes: 3, sanityPerRun: 36, isOpen: true, materials: [{ name: '龙门币', count: 10000 }] }],
    openStages: [{ stage: 'CE-6', totalTimes: 3, isOpen: true, materials: [{ name: '龙门币', count: 10000 }] }],
    closedStages: [],
    totalSanity: 108,
    materialHierarchy: [],
  }
  return {
    runState: 'running',
    runId: stateRunId,
    operationId: 'run_daily_flow',
    staleRunId: 'run-cross-page-stale-terminal',
    stopCalls: [],
    submissions: [],
    automationConfig: createInitialAutomationConfig(),
    automationSaveCalls: [],
    scheduleCalls: [],
    scheduleFailuresRemaining: 0,
    operBox,
    trainingQueue: { ...queue, revision: 'integration-queue-v1', flowSync: { status: 'not_applied', flowName: '自动任务' } },
    plan,
    applyCalls: [],
    applyResult: {
      stageCount: 1,
      flowSync: { status: 'synced', flowName: '自动任务', taskName: '理智作战' },
      scheduleSync: { attempted: true, success: true },
    },
    requests: [],
  }
}

async function fulfill(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
}

function readBody(request: Request): unknown {
  const raw = request.postData()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return raw }
}

async function respondToApi(route: Route, state: ScenarioState): Promise<void> {
  const request = route.request()
  const method = request.method()
  const url = new URL(request.url())
  const path = url.pathname.replace(/^\/api/, '')
  const body = readBody(request)
  state.requests.push({ method, path, body })

  if (path === '/agent/runs/current' && method === 'GET') return fulfill(route, ok(makeSnapshot(state)))
  if (path === `/agent/runs/${state.runId}` && method === 'GET') return fulfill(route, ok(makeRun(state.runState, state.runId, state.operationId)))
  if (path === `/agent/runs/${state.staleRunId}` && method === 'GET') return fulfill(route, ok(makeRun('stopped', state.staleRunId)))
  if (path === '/agent/runs/run-statistics-recognition' && method === 'GET') {
    return fulfill(route, ok({ ...makeRun('succeeded', 'run-statistics-recognition'), operationId: 'run_task' }))
  }

  if (path === '/agent/schedules/manual/execute' && method === 'POST') {
    state.submissions.push({ method, path, body })
    state.runState = 'running'
    const run = makeRun(state.runState, state.runId)
    return fulfill(route, ok({ accepted: true, runId: state.runId, run, scheduleId: 'manual', totalSteps: 3 }), 202)
  }
  if (path === '/agent/actions/stop' && method === 'POST') {
    const requestedRunId = (body as { runId?: string } | null)?.runId ?? url.searchParams.get('runId') ?? ''
    state.stopCalls.push(requestedRunId)
    if (requestedRunId === state.staleRunId) {
      return fulfill(route, ok({ stopRequested: false, deviceStopRequested: false, alreadyTerminal: true, run: makeRun('stopped', state.staleRunId) }))
    }
    if (requestedRunId !== state.runId) {
      return fulfill(route, failure('目标运行不存在', 'AGENT_RUN_NOT_FOUND'), 404)
    }
    if (state.runState === 'stopped') {
      return fulfill(route, ok({ stopRequested: false, deviceStopRequested: false, alreadyTerminal: true, run: makeRun('stopped', state.runId) }))
    }
    state.runState = 'stopping'
    return fulfill(route, ok({ stopRequested: true, deviceStopRequested: true, run: makeRun('stopping', state.runId) }))
  }

  if (path === '/agent/config/user/automation-tasks') {
    if (method === 'GET') return fulfill(route, ok(state.automationConfig))
    if (method === 'POST') {
      state.automationSaveCalls.push({ method, path, body })
      state.automationConfig = clone(body) as Record<string, unknown>
      return fulfill(route, ok({}))
    }
  }
  if (path === '/agent/config/user/training-queue' && method === 'GET') {
    return fulfill(route, ok({ queue: (state.trainingQueue.queue as unknown[]) ?? [] }))
  }
  if (path === '/agent/schedules' && method === 'POST') {
    state.scheduleCalls.push({ method, path, body })
    if (state.scheduleFailuresRemaining > 0) {
      state.scheduleFailuresRemaining -= 1
      return fulfill(route, failure('定时注册暂未确认，请重试'))
    }
    return fulfill(route, ok({ scheduleId: 'default', times: (body as { times?: unknown[] }).times ?? [] }))
  }
  if (path === '/agent/schedules/default' && method === 'DELETE') {
    state.scheduleCalls.push({ method, path, body })
    return fulfill(route, ok({}))
  }

  if (path === '/agent/actions/run-task' && method === 'POST') {
    state.submissions.push({ method, path, body })
    const runId = 'run-statistics-recognition'
    const run = {
      ...makeRun('succeeded', runId),
      operationId: 'run_task',
      progress: undefined,
      result: { success: true },
    }
    return fulfill(route, ok({ runId, run, success: true }))
  }
  if (path === '/agent/actions/operbox-recognition' && method === 'POST') return fulfill(route, ok(state.operBox))
  if (path === '/agent/data/operbox' && method === 'GET') return fulfill(route, ok(state.operBox))

  if (path === '/agent/training/queue' && method === 'GET') return fulfill(route, ok(state.trainingQueue))
  if (path === '/agent/training/plan' && method === 'POST') return fulfill(route, ok(state.plan))
  if (path === '/agent/actions/apply-training-plan' && method === 'POST') {
    state.applyCalls.push({ method, path, body })
    const stages = (state.plan.openStages ?? state.plan.stages) as Array<Record<string, unknown>>
    const flow = (state.automationConfig.taskFlow ?? []) as Array<Record<string, unknown>>
    state.automationConfig = {
      ...state.automationConfig,
      taskFlow: flow.map(task => task.commandId === 'fight'
        ? {
            ...task,
            params: {
              ...(task.params as Record<string, unknown>),
              stages: [
                ...(((task.params as Record<string, unknown>).stages ?? []) as Array<Record<string, unknown>>).filter(stage => !stage.smart),
                ...stages.map(stage => ({ stage: stage.stage, times: String(stage.totalTimes), smart: true, trainingOperators: ['艾雅法拉'] })),
              ],
            },
          }
        : task),
    }
    state.trainingQueue = {
      ...state.trainingQueue,
      flowSync: { status: 'synced', flowName: '自动任务', taskName: '理智作战', syncedRevision: 'integration-queue-v1' },
    }
    return fulfill(route, ok(state.applyResult))
  }

  const payload = fixturePayload(path, method)
  if (payload !== undefined) return fulfill(route, payload)
  throw new Error(`未登记的跨页场景请求: ${method} ${path}`)
}

export async function installIntegrationScenario(page: Page, state: ScenarioState): Promise<void> {
  recordBrowserErrors(page)
  await page.addInitScript(() => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => new Promise(() => {})
  })
  await page.route('**/api/**', route => respondToApi(route, state))
  for (const host of EXTERNAL_IMAGE_HOSTS) {
    await page.route(`https://${host}/**`, route => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'),
    }))
  }
  await page.route('**/sw.js', route => route.fulfill({ status: 404, body: 'service worker disabled' }))
}

export async function navigateTo(page: Page, tab: 'dashboard' | 'automation' | 'training' | 'statistics'): Promise<void> {
  await page.locator(`[data-app-tab="${tab}"]:visible`).click()
  await expect(page).toHaveURL(new RegExp(`/app/${tab}$`))
}

export async function gotoScenario(page: Page, tab: 'dashboard' | 'automation' | 'training' | 'statistics'): Promise<void> {
  await page.goto(`/app/${tab}`)
  await expect(page.locator(`[data-app-tab="${tab}"]:visible`)).toHaveAttribute('aria-current', 'page')
}

export async function expectScenarioHealthy(page: Page): Promise<void> {
  await expectNoBrowserErrors(page)
}

export function requestsFor(state: ScenarioState, path: string, method?: string): ScenarioRequest[] {
  return state.requests.filter(request => request.path === path && (!method || request.method === method))
}
