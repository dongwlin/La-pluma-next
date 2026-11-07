import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { apiFixtures, ok, type ApiFixture } from './fixtures'
import {
  THEMES,
  installDeterministicEnvironment,
  themeSeedScript,
  waitForPageReady,
} from './harness'

/**
 * 策略设置的字段栅格只在面板容器宽度 ≥32rem 时切成两列；现有 tab 基线
 * （390 / 820 / 1440）都落在单列区间，核心干员独占整行只在这个宽屏状态可见，
 * 因此单独在 1920 视口截取设置卡片，锁定跨列布局与完整干员名。
 */
const wideSettingsFixtures: ApiFixture[] = apiFixtures.map(fixture =>
  fixture.path === '/agent/config/user/roguelike-tasks'
    ? {
        ...fixture,
        payload: ok({
          taskInputs: { roguelike: 'Mizuki' },
          advancedParams: { roguelike: { coreChar: '维什戴尔' } },
        }),
      }
    : fixture)

for (const theme of THEMES) {
  test.describe(`roguelike settings wide layout: ${theme}`, () => {
    test.use({ viewport: { width: 1920, height: 1080 } })

    test.beforeEach(async ({ page }) => {
      recordBrowserErrors(page)
      await page.addInitScript(themeSeedScript(theme))
    })

    test(`core operator field spans the full row ${theme}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'desktop', 'wide desktop layout is captured once')

      const environment = await installDeterministicEnvironment(page, { fixtures: wideSettingsFixtures })

      await page.goto('/app/roguelike')
      await waitForPageReady(page, 'roguelike')

      const panel = page.locator('.roguelike-settings-panel')
      await expect(panel).toBeVisible()
      await expect(page.getByRole('button', { name: '核心干员', exact: true })).toBeVisible()

      await expect(panel).toHaveScreenshot(`roguelike-settings-wide-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
      })

      environment.assertNoUnmatchedApi()
      await expectNoBrowserErrors(page)
    })
  })
}
