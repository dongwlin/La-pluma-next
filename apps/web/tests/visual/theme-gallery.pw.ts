import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import {
  THEMES,
  installDeterministicEnvironment,
  themeSeedScript,
  waitForPageReady,
} from './harness'

/**
 * 主题画廊是 shadcn 迁移的护栏画布：零 API 依赖，因此截图只关心主题种子与
 * 确定性环境；只跑 desktop 投影，迁移批次在同一画布上比对全局表面。
 */
for (const theme of THEMES) {
  test.describe(`theme gallery: ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      recordBrowserErrors(page)
      await page.addInitScript(themeSeedScript(theme))
    })

    test(`full page ${theme}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'desktop', 'theme gallery is captured once per theme')

      const environment = await installDeterministicEnvironment(page)

      await page.goto('/dev/theme-gallery')
      await waitForPageReady(page, 'gallery')

      await expect(page).toHaveScreenshot(`theme-gallery-${theme}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      })

      environment.assertNoUnmatchedApi()
      await expectNoBrowserErrors(page)
    })
  })
}
