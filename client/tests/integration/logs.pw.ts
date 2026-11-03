import { expect, test, type Page } from '@playwright/test'
import {
  createScenarioState,
  expectScenarioHealthy,
  gotoScenario,
  installIntegrationScenario,
  makeRun,
  navigateTo,
  ok,
  requestsFor,
} from './harness'

interface SourceLog {
  id: string
  sequence: number
  time: string
  level: 'INFO'
  message: string
  runId?: string
}

const record = (sequence: number, message: string, runId?: string): SourceLog => ({
  id: `log-source:${sequence}`,
  sequence,
  time: `2026-10-24T04:00:${String(sequence).padStart(2, '0')}.123Z`,
  level: 'INFO',
  message,
  ...(runId ? { runId } : {}),
})

const logRegion = (page: Page) => page.getByRole('log', { name: '日志内容' })

test('日志呈现共享筛选事件，指定 Run 在终态和后续执行期间保持不变', async ({ page }) => {
  const state = createScenarioState()
  const selectedRunId = state.runId
  const command = '执行命令: maa fight, 等待完成: true'
  const logs = [
    record(1, command, selectedRunId),
    record(2, '固定范围事件', selectedRunId),
    record(3, '另一次执行记录', 'run-other'),
    record(4, '未关联采集记录'),
  ]
  await installIntegrationScenario(page, state)
  await page.route('**/api/agent/logs/recent?*', route => route.fulfill({ json: ok(logs) }))
  await page.route(`**/api/agent/runs/${selectedRunId}`, route => route.fulfill({
    json: ok(makeRun(state.runId === selectedRunId ? state.runState : 'succeeded', selectedRunId)),
  }))
  await gotoScenario(page, 'logs')
  const scope = page.getByRole('combobox', { name: '执行范围', exact: true })
  await expect(scope).toHaveValue('')
  await expect(logRegion(page).getByText('未关联采集记录', { exact: true }).first()).toBeVisible()
  await scope.selectOption(selectedRunId)
  await expect(logRegion(page).getByText('开始执行：理智作战', { exact: true })).toBeVisible()
  await expect(logRegion(page).getByText('固定范围事件', { exact: true }).first()).toBeVisible()
  await expect(logRegion(page).getByText('另一次执行记录', { exact: true })).toHaveCount(0)
  await expect(logRegion(page).getByText('记录详情', { exact: true })).toHaveCount(2)

  await page.getByRole('tab', { name: '原文', exact: false }).click()
  await expect(logRegion(page).getByText(command, { exact: true }).first()).toBeVisible()
  await expect(logRegion(page).getByText('记录详情', { exact: true })).toHaveCount(2)
  await expect(scope).toHaveValue(selectedRunId)
  await page.getByRole('tab', { name: '易读', exact: false }).click()
  await expect(logRegion(page).getByText('开始执行：理智作战', { exact: true })).toBeVisible()

  state.runState = 'succeeded'
  const beforeTerminal = requestsFor(state, '/agent/runs/current', 'GET').length
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => requestsFor(state, '/agent/runs/current', 'GET').length).toBeGreaterThan(beforeTerminal)
  await expect(scope).toHaveValue(selectedRunId)
  await expect(logRegion(page).getByText('另一次执行记录', { exact: true })).toHaveCount(0)

  state.runId = 'run-after-selected'
  state.runState = 'running'
  logs.push(record(5, '新执行的日志', state.runId))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(scope.getByRole('option', { name: `Run · ${state.runId}`, exact: true })).toBeAttached()
  await expect(scope).toHaveValue(selectedRunId)
  await expect(logRegion(page).getByText('新执行的日志', { exact: true })).toHaveCount(0)
  await expect(logRegion(page).getByText('固定范围事件', { exact: true }).first()).toBeVisible()
  await expectScenarioHealthy(page)
})

test('清屏保持本地边界，Activity 隐藏取消读取并在返回后保留范围', async ({ page }) => {
  const state = createScenarioState()
  const selectedRunId = state.runId
  const logs = [record(1, '清屏前的记录', selectedRunId), record(2, '其他执行记录', 'run-other')]
  let reads = 0
  let sharedClearCalls = 0
  let holdNextRead = false
  let heldReadStarted = false
  let releaseHeldRead!: () => void
  const heldReadGate = new Promise<void>(resolve => { releaseHeldRead = resolve })
  await page.clock.install()
  await installIntegrationScenario(page, state)
  await page.route('**/api/agent/logs/recent/clear', route => {
    sharedClearCalls += 1
    return route.fulfill({ json: ok({}) })
  })
  await page.route('**/api/agent/logs/recent?*', async route => {
    reads += 1
    if (holdNextRead) {
      holdNextRead = false
      heldReadStarted = true
      await heldReadGate
      await route.fulfill({ json: ok([record(99, '迟到读取不应覆盖', selectedRunId)]) })
      return
    }
    await route.fulfill({ json: ok(logs) })
  })
  try {
    await gotoScenario(page, 'logs')
    const scope = page.getByRole('combobox', { name: '执行范围', exact: true })
    await expect(logRegion(page).getByText('清屏前的记录', { exact: true }).first()).toBeVisible()
    await scope.selectOption(selectedRunId)
    await page.getByRole('button', { name: '清屏', exact: true }).click()
    await expect(logRegion(page).getByText('清屏前的记录', { exact: true })).toHaveCount(0)
    const readsBeforePoll = reads
    await expect.poll(() => reads).toBeGreaterThan(readsBeforePoll)
    await expect(logRegion(page).getByText('清屏前的记录', { exact: true })).toHaveCount(0)
    expect(sharedClearCalls).toBe(0)
    logs.push(record(3, '清屏后的新记录', selectedRunId))
    await expect(logRegion(page).getByText('清屏后的新记录', { exact: true }).first()).toBeVisible()

    holdNextRead = true
    await expect.poll(() => heldReadStarted).toBe(true)
    const cancelledRead = page.waitForEvent('requestfailed', {
      predicate: request => new URL(request.url()).pathname === '/api/agent/logs/recent',
    })
    await navigateTo(page, 'dashboard')
    const cancelled = await cancelledRead
    expect(cancelled.failure()?.errorText).toContain('ERR_ABORTED')
    const readsWhileHidden = reads
    await page.clock.runFor(3000)
    expect(reads).toBe(readsWhileHidden)
    releaseHeldRead()

    await navigateTo(page, 'logs')
    await expect(scope).toHaveValue(selectedRunId)
    await expect(logRegion(page).getByText('清屏后的新记录', { exact: true }).first()).toBeVisible()
    await expect(logRegion(page).getByText('清屏前的记录', { exact: true })).toHaveCount(0)
    await expect(logRegion(page).getByText('迟到读取不应覆盖', { exact: true })).toHaveCount(0)
    expect(sharedClearCalls).toBe(0)
    await expectScenarioHealthy(page)
  } finally {
    releaseHeldRead()
  }
})
