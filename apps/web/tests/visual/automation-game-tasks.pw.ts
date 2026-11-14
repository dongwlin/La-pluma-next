import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { apiFixtures, ok } from './fixtures'
import {
  installDeterministicEnvironment,
  themeSeedScript,
  waitForPageReady,
} from './harness'

const gameTaskFixtures = [
  ...apiFixtures,
  { path: '/agent/schedules', method: 'POST', payload: ok({}) },
]

test.describe('game tasks', () => {
  test.beforeEach(async ({ page }) => {
    recordBrowserErrors(page)
    await page.addInitScript(themeSeedScript('dark'))
  })

  test('operator progression editor', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'progression editor is captured once on desktop')

    const environment = await installDeterministicEnvironment(page, { fixtures: gameTaskFixtures })
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')
    await page.getByRole('button', { name: '添加任务' }).click()
    await page.getByRole('menuitem', { name: '游戏内培养' }).click()
    await page.getByRole('button', { name: '添加培养计划' }).click()
    await page.getByRole('button', { name: '选择干员' }).click()
    const operatorDialog = page.getByRole('dialog')
    await operatorDialog.waitFor({ state: 'visible' })
    const chenChoice = page.getByRole('button', { name: '选择陈', exact: true })
    await chenChoice.waitFor({ state: 'visible' })
    await chenChoice.click()
    await page.getByRole('button', { name: '确认选择', exact: true }).click()
    await page.getByLabel('培养计划 1 精英目标', { exact: true }).selectOption('2')
    await page.getByLabel('培养计划 1 技能等级', { exact: true }).selectOption('7')
    await page.getByLabel('培养计划 1 技能 3 专精', { exact: true }).selectOption('1')
    await page.getByRole('heading', { name: '任务配置', exact: true }).scrollIntoViewIfNeeded()

    await expect(page).toHaveScreenshot('operator-progression-top-dark.png', {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      // 分数像素定位下 Chromium 会把 WQY Zen Hei 的输入框占位文本整体栅格到
      // 相邻行（约 180 像素），与布局和字体选择无关；只放行这一抖动。
      maxDiffPixels: 250,
    })
    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
