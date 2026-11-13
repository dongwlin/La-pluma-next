import { expect, test } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { apiFixtures, ok, type ApiFixture } from './fixtures'
import {
  THEMES,
  installDeterministicEnvironment,
  themeSeedScript,
  waitForPageReady,
} from './harness'

const shortFlowFixtures: ApiFixture[] = apiFixtures.map(fixture =>
  fixture.path === '/agent/config/user/automation-tasks'
    ? {
        ...fixture,
        payload: ok({
          taskFlow: [
            {
              id: 'startup-visual-1',
              commandId: 'startup',
              name: '启动游戏',
              description: '启动游戏客户端',
              defaultParams: { clientType: 'Official' },
              params: { clientType: 'Official', address: '127.0.0.1:5555' },
              enabled: true,
            },
          ],
          schedule: { enabled: true, entries: [] },
        }),
      }
    : fixture)

for (const theme of THEMES) {
  test.describe(`task picker: ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      recordBrowserErrors(page)
      await page.addInitScript(themeSeedScript(theme))
    })

    test(`shows the add-task options above a short flow without clipping ${theme}`, async ({ page }) => {
      const environment = await installDeterministicEnvironment(page, { fixtures: shortFlowFixtures })

      await page.goto('/app/automation')
      await waitForPageReady(page, 'automation')

      await page.getByRole('button', { name: '添加任务' }).click()
      const menu = page.getByRole('menu', { name: '可添加任务' })
      await expect(menu).toBeVisible()
      await expect(menu).toHaveCSS('opacity', '1')

      const viewport = page.viewportSize()!
      const menuBox = await menu.boundingBox()
      expect(menuBox).not.toBeNull()
      expect(menuBox!.y).toBeGreaterThanOrEqual(0)
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height)

      const clippedOptions = await page.evaluate(() => {
        const picker = document.querySelector('#automation-task-picker')
        if (!picker) throw new Error('task picker menu is missing')
        const menuRect = picker.getBoundingClientRect()

        return Array.from(picker.querySelectorAll<HTMLElement>('[role="menuitem"]')).flatMap(option => {
          const rect = option.getBoundingClientRect()
          const insideMenu = rect.top >= menuRect.top && rect.bottom <= menuRect.bottom
          if (!insideMenu) return []

          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return hit === option || option.contains(hit) ? [] : [option.textContent ?? '']
        })
      })

      expect(clippedOptions).toEqual([])

      environment.assertNoUnmatchedApi()
      await expectNoBrowserErrors(page)
    })
  })
}
