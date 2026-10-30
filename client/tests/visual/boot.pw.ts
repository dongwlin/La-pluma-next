import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import {
  THEMES,
  installDeterministicEnvironment,
  themeSeedScript,
} from './harness'

/**
 * 启动壳视觉基线：abort 入口模块（assets/index-*.js），让 React 不执行，
 * 页面停在 index.html 的内联启动壳上。safe-area、dvh 与 standalone 的
 * viewport 变量只有在真实浏览器里才生效，这里按视口截图验收。
 */
for (const theme of THEMES) {
  test(`boot-shell ${theme}`, async ({ page }) => {
    await page.addInitScript(themeSeedScript(theme))
    recordBrowserErrors(page)
    const environment = await installDeterministicEnvironment(page)
    await page.route('**/assets/index-*.js', route => route.abort())

    await page.goto('/app/dashboard')
    await page.locator('.la-pluma-boot').waitFor({ state: 'visible' })
    await page.evaluate(() => document.fonts.ready)

    await expect(page).toHaveScreenshot(`boot-shell-${theme}.png`, {
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
    })

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
}
