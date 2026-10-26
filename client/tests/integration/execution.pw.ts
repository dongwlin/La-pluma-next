import { expect, test } from '@playwright/test'
import {
  createScenarioState,
  expectScenarioHealthy,
  gotoScenario,
  installIntegrationScenario,
  makeRun,
  makeSnapshot,
  navigateTo,
  ok,
  requestsFor,
} from './harness'

test('停止中切页、断线重连和刷新都保留同一 Run，旧终态不会误伤新执行', async ({ page, context }) => {
  const state = createScenarioState()
  state.runState = 'succeeded'
  await installIntegrationScenario(page, state)
  await gotoScenario(page, 'automation')
  await expect(page.getByRole('button', { name: '立即执行', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '开始今日流程' })).toHaveCount(0)

  // 同一个真实浏览器流程中只提交一次，Activity 切换不会创建第二个流程引擎。
  await page.getByRole('button', { name: '立即执行', exact: true }).click()
  await expect.poll(() => state.submissions.length).toBe(1)
  await expect(page.getByRole('button', { name: '终止执行', exact: true })).toBeVisible()
  await expect(page.locator('.floating-status-text:visible').first()).toHaveText('正在执行跨页场景任务')
  await navigateTo(page, 'dashboard')
  await expect(page.locator('.dashboard-flow-command').getByText('正在执行跨页场景任务', { exact: true })).toBeVisible()
  await navigateTo(page, 'automation')

  await page.getByRole('button', { name: '终止执行', exact: true }).click()
  await expect.poll(() => state.stopCalls).toEqual([state.runId])

  // 停止确认尚未到达终态时切到总览：页面组合层和全局指示器来自同一快照。
  await navigateTo(page, 'dashboard')
  await expect(page.locator('.dashboard-flow-command').getByText('正在停止', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '正在运行', exact: true })).toBeDisabled()

  // 原生 offline 事件与 fetch 失败一样属于未知，不得把最后活动 Run 当成完成。
  await context.setOffline(true)
  await expect(page.locator('.dashboard-flow-command').getByText('当前网络离线', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始今日流程', exact: true })).toBeDisabled()
  await expect.poll(() => page.locator('.floating-status-text:visible').first().getAttribute('title')).toBe('网络连接已断开，页面控制暂不可用')

  // 在线请求失败期间也没有提交新任务；恢复后先按原 runId 对账。
  await context.setOffline(false)
  let rejectSnapshots = true
  await page.route('**/api/agent/runs/current', async route => {
    if (rejectSnapshots) await route.abort('failed')
    else await route.fallback()
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.dashboard-flow-command').getByText('执行状态未知', { exact: true })).toBeVisible()
  await navigateTo(page, 'automation')
  await expect(page.getByRole('button', { name: '正在终止', exact: true })).toBeVisible()
  expect(state.submissions).toHaveLength(1)

  rejectSnapshots = false
  await page.unroute('**/api/agent/runs/current')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '正在终止', exact: true })).toBeVisible()
  await expect.poll(() => requestsFor(state, `/agent/runs/${state.runId}`, 'GET').length).toBeGreaterThan(0)

  // 浏览器刷新销毁页面实例，但服务端 Run 与持久化身份仍在；只恢复观察。
  await page.reload()
  await expect(page.locator('[data-app-tab="automation"]:visible')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: '正在终止', exact: true })).toBeVisible()
  await navigateTo(page, 'dashboard')
  await expect(page.locator('.dashboard-flow-command').getByText('正在停止', { exact: true })).toBeVisible()
  await navigateTo(page, 'automation')
  expect(state.submissions).toHaveLength(1)
  expect(state.stopCalls).toEqual([state.runId])

  state.runState = 'stopped'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '立即执行', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '最近执行结果' })).toContainText('成功 1')
  await navigateTo(page, 'dashboard')
  await expect(page.locator('.dashboard-flow-command').getByText('准备就绪', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始今日流程', exact: true })).toBeEnabled()

  // 旧身份尚未完成恢复时，其他客户端已启动新 Run；旧停止只确认旧终态。
  const previousStopCalls = [...state.stopCalls]
  state.runId = 'run-cross-page-new'
  state.runState = 'running'
  let releaseOldRead!: () => void
  let oldReadStarted = false
  const oldReadGate = new Promise<void>(resolve => { releaseOldRead = resolve })
  await page.route('**/api/agent/runs/current', route => route.fulfill({
    json: ok({ ...makeSnapshot(state), lastRun: null }),
  }))
  await page.route(`**/api/agent/runs/${state.staleRunId}`, async route => {
    oldReadStarted = true
    await oldReadGate
    await route.fulfill({ json: ok(makeRun('stopped', state.staleRunId)) })
  })
  await page.addInitScript(({ staleRunId }) => {
    localStorage.setItem('la-pluma-execution-identity-v1', JSON.stringify({
      runId: staleRunId, operationId: 'run_daily_flow', scope: 'automation',
    }))
  }, { staleRunId: state.staleRunId })
  try {
    await page.reload()
    await expect.poll(() => oldReadStarted).toBe(true)
    await navigateTo(page, 'automation')
    expect(state.stopCalls).toEqual(previousStopCalls)
    await expect(page.getByRole('button', { name: '终止执行', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '终止执行', exact: true }).click()
    await expect.poll(() => state.stopCalls).toEqual([...previousStopCalls, state.staleRunId])
    releaseOldRead()
    await expect(page.getByRole('button', { name: '终止执行', exact: true })).toHaveCount(0)
    await navigateTo(page, 'dashboard')
    await expect(page.locator('.dashboard-flow-command').getByText('正在执行跨页场景任务', { exact: true })).toBeVisible()
    expect(state.runState).toBe('running')
    expect(state.submissions).toHaveLength(1)
  } finally {
    releaseOldRead()
  }

  await expectScenarioHealthy(page)
})

test('同步活动预检在响应前就能被其他页面观察，阻断原因不会伪造成执行结果', async ({ page, context }) => {
  const state = createScenarioState()
  state.runState = 'succeeded'
  await installIntegrationScenario(page, state)
  let finishActivity!: () => void
  const activityGate = new Promise<void>(resolve => { finishActivity = resolve })
  await page.route('**/api/agent/activity/run', async route => {
    state.submissions.push({ method: 'POST', path: '/agent/activity/run', body: null })
    state.runState = 'running'
    state.operationId = 'run_current_activity_copilots'
    await activityGate
    const run = makeRun('succeeded', state.runId, state.operationId)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          runId: state.runId,
          run,
          executed: false,
          plan: { reason: '活动导航链尚未完成，未提交任何活动作业' },
        },
      }),
    })
  })
  await gotoScenario(page, 'dashboard')
  await expect(page.getByRole('button', { name: '打当前活动', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: '打当前活动', exact: true }).click()
  await expect.poll(() => state.submissions.length).toBe(1)
  await expect(page.locator('.dashboard-flow-command').getByText('正在检查当前活动', { exact: true })).toBeVisible()
  await navigateTo(page, 'automation')
  await expect(page.getByRole('button', { name: '终止执行', exact: true })).toHaveCount(0)
  await navigateTo(page, 'dashboard')
  await expect(page.getByRole('button', { name: '正在运行', exact: true })).toBeDisabled()
  await expect(page.locator('.floating-status-text:visible').first()).toHaveText('正在检查当前活动是否可以执行…')
  expect(state.submissions).toHaveLength(1)

  // 新浏览器页面没有发起方的 loading/message，只能从服务端快照观察预检。
  const observer = await context.newPage()
  await installIntegrationScenario(observer, state)
  await gotoScenario(observer, 'dashboard')
  await expect(observer.locator('.dashboard-flow-command').getByText('正在检查活动导航链', { exact: true })).toBeVisible()
  await expect(observer.getByRole('button', { name: '正在运行', exact: true })).toBeDisabled()
  await expectScenarioHealthy(observer)
  await observer.close()

  finishActivity()
  state.runState = 'succeeded'
  await navigateTo(page, 'dashboard')
  await expect(page.locator('[data-dashboard-flow-feedback]')).toHaveText('活动导航链尚未完成，未提交任何活动作业')
  await expectScenarioHealthy(page)
})
