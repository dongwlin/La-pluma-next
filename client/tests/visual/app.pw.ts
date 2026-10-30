import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import {
  READY_MARKER,
  THEMES,
  installDeterministicEnvironment,
  themeSeedScript,
  waitForPageReady,
} from './harness'

/**
 * 视觉基线：8 个 tab × 深/浅主题 × 桌面/平板/移动视口 = 48 张。
 *
 * 确定性的构造方式（固定数据、外部资源、时间、动效、主题）见 harness.ts
 * 文件头；本文件只负责导航到每个 tab、等就绪标记、整页截图。
 */
for (const theme of THEMES) {
  test.describe(`theme: ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      recordBrowserErrors(page)
      await page.addInitScript(themeSeedScript(theme))
    })

    for (const tab of Object.keys(READY_MARKER)) {
      test(`app tab: ${tab}`, async ({ page }) => {
        const environment = await installDeterministicEnvironment(page)

        await page.goto(`/app/${tab}`)

        // 就绪标记是 fixture 驱动的 UI 文本/输入值，证明页面已完成数据渲染。
        await waitForPageReady(page, tab)

        // 就绪与字体已确认；截图断言在绘制帧后采样，不匹配时等待画面稳定。
        await expect(page).toHaveScreenshot(`${tab}-${theme}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
        })

        environment.assertNoUnmatchedApi()
        await expectNoBrowserErrors(page)
      })
    }
  })
}
