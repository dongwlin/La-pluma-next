import { expect, test, type Page, type Request } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { installDeterministicEnvironment, themeSeedScript, waitForPageReady } from '../visual/harness'
import { APPENDED_LOGS, INITIAL_LOGS, SEARCH_RESULT, TRAINING_QUEUE } from './fixtures'

const SAMPLE_COUNT = 5
const API_DELAY_MS = 25
const MOTION_FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`
const output = process.env.PERFORMANCE_OUTPUT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence/frontend-final/production.json')
const SCENARIOS = ['automation-drag', 'copilot-search', 'log-append', 'training-reorder', 'automation-keyboard'] as const
const profiling = process.env.PERFORMANCE_PROFILE === '1'
const samples: Record<string, unknown>[] = []
let browserVersion = ''

interface ApiRequest {
  method: string
  path: string
  bodySha256?: string
  bodySummary?: unknown
  startedAt: number
  finishedAt?: number
  status?: number
  failure?: string
}

interface PointerEvidence {
  type: string
  x: number
  y: number
  button: string | null
}

interface ReactCommit {
  id: string
  phase: string
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
}

interface ReactSample {
  enabled: boolean
  commits: ReactCommit[]
}

function summarizeBody(body: string | null): unknown {
  if (!body) return undefined
  const value = JSON.parse(body)
  return {
    ...(value.operatorIds ? { operatorIds: value.operatorIds } : {}),
    ...(value.taskFlow ? { taskIds: value.taskFlow.map((task: { id: string }) => task.id) } : {}),
    ...(value.schedule ? { schedule: value.schedule } : {}),
    ...(value.scheduleId ? { scheduleId: value.scheduleId, times: value.times } : {}),
  }
}

function recordApi(page: Page) {
  const requests = new Map<Request, ApiRequest>()
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return
    const body = request.postData()
    requests.set(request, {
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      ...(body ? { bodySha256: createHash('sha256').update(body).digest('hex'), bodySummary: summarizeBody(body) } : {}),
      startedAt: performance.now(),
    })
  })
  page.on('response', response => {
    const request = requests.get(response.request())
    if (request) request.status = response.status()
  })
  page.on('requestfinished', request => {
    const entry = requests.get(request)
    if (entry) entry.finishedAt = performance.now()
  })
  page.on('requestfailed', request => {
    const entry = requests.get(request)
    if (entry) {
      entry.finishedAt = performance.now()
      entry.failure = request.failure()?.errorText
    }
  })
  return {
    pendingSince(start: number) {
      return [...requests.values()].filter(request => request.startedAt >= start && request.finishedAt === undefined).length
    },
    since(start: number) {
      return [...requests.values()].filter(request => request.startedAt >= start).map(request => ({
        method: request.method,
        path: request.path,
        ...(request.bodySha256 ? { bodySha256: request.bodySha256, bodySummary: request.bodySummary } : {}),
        startedAfterMs: round(request.startedAt - start),
        durationMs: request.finishedAt ? round(request.finishedAt - request.startedAt) : null,
        status: request.status ?? null,
        ...(request.failure ? { failure: request.failure } : {}),
      }))
    },
    before(start: number) {
      return [...requests.values()].filter(request => request.startedAt < start)
        .reduce<Record<string, number>>((counts, request) => {
          const key = `${request.method} ${request.path}`
          counts[key] = (counts[key] ?? 0) + 1
          return counts
        }, {})
    },
  }
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

async function measure(page: Page, action: () => Promise<void>) {
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  const before = await client.send('Performance.getMetrics')
  await page.evaluate(expectProfile => {
    const collector = (window as unknown as { __reactProfiler?: ReactSample }).__reactProfiler
    if (expectProfile && !collector) throw new Error('React profiling collector is absent')
    if (!expectProfile && collector) throw new Error('Ordinary production build unexpectedly has profiling instrumentation')
    if (collector) {
      collector.commits = []
      collector.enabled = true
    }
    const state = {
      startedAt: performance.now(),
      mutationCallbacks: 0,
      childListMutations: 0,
      addedNodes: 0,
      removedNodes: 0,
      attributeMutations: 0,
      characterDataMutations: 0,
      longTasks: [] as number[],
    }
    const mutations = new MutationObserver(records => {
      state.mutationCallbacks += 1
      for (const record of records) {
        if (record.type === 'childList') {
          state.childListMutations += 1
          state.addedNodes += record.addedNodes.length
          state.removedNodes += record.removedNodes.length
        } else if (record.type === 'attributes') state.attributeMutations += 1
        else state.characterDataMutations += 1
      }
    })
    mutations.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true })
    const longTasks = new PerformanceObserver(list => {
      state.longTasks.push(...list.getEntries().map(entry => entry.duration))
    })
    longTasks.observe({ type: 'longtask', buffered: false })
    Object.assign(window, { __performanceSample: { state, mutations, longTasks } })
  }, profiling)
  await action()
  // Two real animation frames let style/layout/paint work caused by the asserted UI finish.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const browser = await page.evaluate(() => {
    const { state, mutations, longTasks } = (window as unknown as {
      __performanceSample: {
        state: { startedAt: number; longTasks: number[] }
        mutations: MutationObserver
        longTasks: PerformanceObserver
      }
    }).__performanceSample
    const durationMs = performance.now() - state.startedAt
    mutations.disconnect()
    // Include entries queued immediately before the observer is disconnected.
    state.longTasks.push(...longTasks.takeRecords().map(entry => entry.duration))
    longTasks.disconnect()
    const collector = (window as unknown as { __reactProfiler?: ReactSample }).__reactProfiler
    if (collector) collector.enabled = false
    return { ...state, startedAt: undefined, durationMs, reactCommits: collector?.commits }
  })
  const after = await client.send('Performance.getMetrics')
  const previous = Object.fromEntries(before.metrics.map(metric => [metric.name, metric.value]))
  const current = Object.fromEntries(after.metrics.map(metric => [metric.name, metric.value]))
  const cdp = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [
    key.endsWith('Duration') ? `${key}Ms` : key,
    round(((current[key] ?? 0) - (previous[key] ?? 0)) * (key.endsWith('Duration') ? 1000 : 1)),
  ]))
  await client.detach()
  const { reactCommits, ...browserMetrics } = browser
  if (profiling) {
    expect(reactCommits?.length).toBeGreaterThan(0)
    expect(reactCommits!.every(commit => commit.id === 'App' && commit.phase !== 'mount'
      && Number.isFinite(commit.actualDuration) && commit.actualDuration >= 0)).toBe(true)
  }
  return {
    browser: { ...browserMetrics, durationMs: round(browser.durationMs), longTasks: browser.longTasks.map(round) },
    cdp,
    ...(reactCommits ? { react: {
      committedUpdates: reactCommits.length,
      actualDurationSumMs: round(reactCommits.reduce((sum, commit) => sum + commit.actualDuration, 0)),
      commits: reactCommits,
    } } : {}),
  }
}

test.afterAll(async () => {
  if (samples.length !== SAMPLE_COUNT * SCENARIOS.length
    || SCENARIOS.some(scenario => samples.filter(sample => sample.scenario === scenario).length !== SAMPLE_COUNT)) return
  await mkdir(path.dirname(output), { recursive: true })
  const metadata = JSON.parse(process.env.PERFORMANCE_METADATA || '{}')
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    ...metadata,
    browserVersion,
    sampleCountPerScenario: SAMPLE_COUNT,
    scenarios: SCENARIOS,
    profilingEnabled: profiling,
    expectedDragOutcome: process.env.PERFORMANCE_EXPECT_DRAG || 'completed',
    clockMode: 'fixed-Date-only; native performance.now/timers/requestAnimationFrame',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    fixedDate: '2026-10-24T04:00:00+08:00',
    theme: 'dark',
    reducedMotion: 'reduce',
    syntheticInteractionApiDelayMs: API_DELAY_MS,
    samples,
  }, null, 2)}\n`)
  await rename(temporary, output) // Complete, validated evidence becomes visible atomically.
})

for (const scenario of SCENARIOS) {
  for (let iteration = 1; iteration <= SAMPLE_COUNT; iteration += 1) {
    test(`${scenario} sample ${iteration}`, async ({ page, browser }) => {
      browserVersion = browser.version()
      const environment = await installDeterministicEnvironment(page, { nativeClock: true })
      await page.addInitScript(themeSeedScript('dark'))
      const api = recordApi(page)
      const errors: string[] = []
      const consoleErrors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
      const reply = async (route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown) => {
        await new Promise(resolve => setTimeout(resolve, API_DELAY_MS))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      }
      let append = false
      const training = structuredClone(TRAINING_QUEUE)
      if (scenario === 'automation-drag' || scenario === 'automation-keyboard') {
        await page.route('**/api/agent/schedules', route => reply(route, { success: true, data: {} }))
        await page.route('**/api/agent/config/user/automation-tasks', route => route.request().method() === 'POST'
          ? reply(route, { success: true, data: {} }) : route.fallback())
      } else if (scenario === 'copilot-search') {
        await page.route('**/api/agent/copilot/search?stage=1-7', route => reply(route, SEARCH_RESULT))
      } else if (scenario === 'log-append') {
        await page.route('**/api/agent/logs/recent?lines=200', route => reply(route, { success: true, data: append ? APPENDED_LOGS : INITIAL_LOGS }))
      } else {
        await page.route('**/api/agent/training/queue', route => reply(route, training))
        await page.route('**/api/agent/training/queue/order', async route => {
          expect(route.request().method()).toBe('PUT')
          const ids: string[] = route.request().postDataJSON().operatorIds
          training.data.queue = ids.map(id => training.data.queue.find(item => item.operatorId === id)!)
          training.data.revision = 'performance-reordered-2'
          await reply(route, { success: true, data: { queueUpdated: true, queueRevision: training.data.revision } })
        })
      }

      const tab = { 'automation-drag': 'automation', 'automation-keyboard': 'automation', 'copilot-search': 'combat', 'log-append': 'logs', 'training-reorder': 'training' }[scenario]
      await page.goto(`/app/${tab}`)
      // Keep the original benchmark's post-navigation freeze and settling period.
      await page.addStyleTag({ content: MOTION_FREEZE_CSS })
      if (scenario === 'log-append') await expect(page.locator('.log-row')).toHaveCount(180)
      else await waitForPageReady(page, tab)
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => ({
        date: Date.now(),
        explicitDate: new Date('2026-10-25T00:00:00Z').getTime(),
        nativePerformance: performance.now.toString().includes('[native code]'),
        nativeTimer: setTimeout.toString().includes('[native code]'),
        nativeFrame: requestAnimationFrame.toString().includes('[native code]'),
      }))).toEqual({
        date: Date.parse('2026-10-24T04:00:00+08:00'),
        explicitDate: Date.parse('2026-10-25T00:00:00Z'),
        nativePerformance: true,
        nativeTimer: true,
        nativeFrame: true,
      })
      await page.waitForTimeout(400)

      // Resolve scroll and coordinates before the measured interval.
      let drag: { fromX: number; fromY: number; toY: number } | undefined
      let pointerEvents: PointerEvidence[] | undefined
      let finalOrder: string[] | undefined
      let dragOutcome: string | undefined
      const requestedOrder = scenario === 'automation-keyboard'
        ? ['理智作战', '启动游戏', '领取奖励'] : ['理智作战', '领取奖励', '启动游戏']
      const requestedIds = scenario === 'automation-keyboard'
        ? ['fight-visual-2', 'startup-visual-1', 'award-visual-3']
        : ['fight-visual-2', 'award-visual-3', 'startup-visual-1']
      if (scenario === 'automation-drag') {
        const handle = page.getByRole('button', { name: '调整启动游戏顺序，当前第 1 位', exact: true })
        await handle.scrollIntoViewIfNeeded()
        const from = await handle.boundingBox()
        const target = await page.locator('.automation-sequence-item').nth(2).boundingBox()
        expect(from).not.toBeNull()
        expect(target).not.toBeNull()
        drag = { fromX: from!.x + from!.width / 2, fromY: from!.y + from!.height / 2, toY: target!.y + target!.height / 2 + 8 }
        await page.mouse.move(drag.fromX, drag.fromY)
        await page.evaluate(() => {
          Object.assign(window, { __pointerEvents: [] })
          for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
            document.addEventListener(type, event => {
              const pointer = event as PointerEvent
              const events = (window as unknown as { __pointerEvents: PointerEvidence[] }).__pointerEvents
              events.push({ type, x: pointer.clientX, y: pointer.clientY, button: (pointer.target as Element).closest('button')?.getAttribute('aria-label') ?? null })
            }, true)
          }
        })
      } else if (scenario === 'automation-keyboard') {
        await page.getByRole('button', { name: '调整启动游戏顺序，当前第 1 位', exact: true }).scrollIntoViewIfNeeded()
      } else if (scenario === 'copilot-search') {
        await page.getByLabel('搜索关卡作业', { exact: true }).scrollIntoViewIfNeeded()
      } else if (scenario === 'training-reorder') {
        await page.getByRole('button', { name: '下移艾雅法拉', exact: true }).scrollIntoViewIfNeeded()
      }

      const setupPageErrors = errors.splice(0)
      const setupConsoleErrors = consoleErrors.splice(0)
      expect(setupPageErrors).toEqual([])
      expect(setupConsoleErrors).toEqual([])
      const start = performance.now()
      const result = await measure(page, async () => {
        if (scenario === 'automation-drag') {
          await page.mouse.down()
          await page.mouse.move(drag!.fromX, drag!.toY, { steps: 12 })
          await page.mouse.up()
          pointerEvents = await page.evaluate(() => (window as unknown as { __pointerEvents: PointerEvidence[] }).__pointerEvents)
          expect(pointerEvents.filter(event => event.type === 'pointerdown')).toHaveLength(1)
          expect(pointerEvents.filter(event => event.type === 'pointerup')).toHaveLength(1)
          finalOrder = await page.locator('.automation-sequence-select strong').allTextContents()
          expect([...finalOrder].sort()).toEqual([...requestedOrder].sort())
          dragOutcome = JSON.stringify(finalOrder) === JSON.stringify(requestedOrder)
            ? 'completed'
            : pointerEvents.some(event => event.type === 'lostpointercapture')
              ? 'cancelled-after-lost-pointer-capture'
              : 'uncommitted'
          expect(dragOutcome).toBe(process.env.PERFORMANCE_EXPECT_DRAG || 'completed')
        } else if (scenario === 'automation-keyboard') {
          await page.getByRole('button', { name: '调整启动游戏顺序，当前第 1 位', exact: true }).press('ArrowDown')
        } else if (scenario === 'copilot-search') {
          await page.getByLabel('搜索关卡作业', { exact: true }).fill('1-7')
          await page.getByLabel('搜索关卡作业', { exact: true }).press('Enter')
          await expect(page.getByText('性能基线作业 5', { exact: true })).toBeVisible()
          await expect(page.getByRole('button').filter({ hasText: /性能基线作业 [1-5]/ })).toHaveCount(5)
          await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeEnabled()
        } else if (scenario === 'log-append') {
          append = true // Production's next 1250 ms poll receives the expanded snapshot.
          await expect(page.locator('.log-row')).toHaveCount(200)
          await expect(page.getByText('追加日志 020：关卡 1-7 任务状态已同步', { exact: true })).toBeVisible()
        } else {
          await page.getByRole('button', { name: '下移艾雅法拉', exact: true }).click()
          await expect(page.locator('.training-operator-name')).toHaveText(['塞雷娅', '艾雅法拉'])
          await expect(page.getByRole('button', { name: '下移塞雷娅', exact: true })).toBeEnabled()
        }
        if (scenario === 'automation-keyboard' || (scenario === 'automation-drag' && dragOutcome === 'completed')) {
          await expect(page.locator('.automation-sequence-select strong')).toHaveText(requestedOrder)
          await expect.poll(() => api.since(start).filter(request => request.method === 'POST'
            && request.path === '/api/agent/config/user/automation-tasks').length).toBe(1)
          await expect.poll(() => page.evaluate(() => localStorage.getItem('automationConfigSyncPending'))).toBeNull()
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('maa-task-flow') || '[]').map((task: { id: string }) => task.id))
          expect(stored).toEqual(requestedIds)
          finalOrder = await page.locator('.automation-sequence-select strong').allTextContents()
        }
        await expect.poll(() => api.pendingSince(start)).toBe(0)
      })
      environment.assertNoUnmatchedApi()
      expect(errors).toEqual([])
      expect(consoleErrors).toEqual([])
      const requests = api.since(start)
      expect(requests.every(request => request.status === 200 && !request.failure)).toBe(true)
      if (scenario === 'copilot-search') {
        expect(requests.filter(request => request.path === '/api/agent/copilot/search?stage=1-7')).toHaveLength(1)
        expect(requests.filter(request => /\/agent\/(copilots|copilot-sets)\//.test(request.path))).toEqual([])
      }
      if (scenario === 'log-append') expect(requests.filter(request => request.path === '/api/agent/logs/recent?lines=200')).toHaveLength(1)
      if (scenario === 'training-reorder') {
        expect(requests.filter(request => request.method === 'PUT' && request.path === '/api/agent/training/queue/order')).toHaveLength(1)
        expect(requests.filter(request => request.method === 'GET' && request.path === '/api/agent/training/queue')).toHaveLength(1)
        expect(requests.find(request => request.method === 'PUT' && request.path === '/api/agent/training/queue/order')?.bodySummary)
          .toMatchObject({ operatorIds: ['char_202_demkni', 'char_180_amgoat'] })
      }
      if (scenario === 'automation-keyboard' || (scenario === 'automation-drag' && dragOutcome === 'completed')) {
        const saved = requests.find(request => request.method === 'POST' && request.path === '/api/agent/config/user/automation-tasks')
        expect(saved?.bodySummary).toMatchObject({ taskIds: requestedIds })
        expect(requests.filter(request => request.method === 'POST' && request.path === '/api/agent/schedules')).toHaveLength(1)
      }
      if (scenario === 'automation-drag' && dragOutcome !== 'completed') {
        expect(finalOrder).toEqual(['启动游戏', '理智作战', '领取奖励'])
        expect(await page.evaluate(() => localStorage.getItem('automationConfigSyncPending'))).toBeNull()
        expect(requests.filter(request => request.method !== 'GET')).toEqual([])
      }
      samples.push({ scenario, iteration, ...result, ...(finalOrder ? {
        requestedOrder,
        finalOrder,
        ...(pointerEvents ? { dragOutcome, pointerEvents } : {}),
      } : {}), setupPageErrors, setupConsoleErrors, measurementPageErrors: [...errors], measurementConsoleErrors: [...consoleErrors], setupRequests: api.before(start), requests })
    })
  }
}
