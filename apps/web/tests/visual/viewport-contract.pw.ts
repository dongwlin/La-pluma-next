import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { installDeterministicEnvironment, themeSeedScript, waitForPageReady } from './harness'

const VIEWPORT_HEIGHT_TOKENS = ['--boot-viewport-height', '--layout-viewport-height'] as const

async function heightToken(page: Page, token: string): Promise<string> {
  return page.evaluate(name => (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  ), token)
}

async function dialogGeometry(dialog: Locator) {
  return dialog.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      viewportHeight: window.innerHeight,
    }
  })
}

async function expectDialogInsideViewport(dialog: Locator) {
  await expect.poll(async () => {
    const geometry = await dialogGeometry(dialog)
    return geometry.height <= geometry.viewportHeight - 32
      && geometry.top >= 0
      && geometry.bottom <= geometry.viewportHeight
  }, { message: '弹层应保持在视口内并至少留出 2rem 的高度差' }).toBe(true)
}

test.describe('viewport contract', () => {
  test('declares interactive widget resizing in the viewport meta', async ({ page }) => {
    recordBrowserErrors(page)
    await page.addInitScript(themeSeedScript('dark'))
    const environment = await installDeterministicEnvironment(page)

    await page.goto('/app/dashboard')
    await waitForPageReady(page, 'dashboard')

    const viewportMeta = page.locator('meta[name="viewport"]')
    await expect(viewportMeta).toHaveCount(1)
    const content = await viewportMeta.getAttribute('content')
    expect(content).toContain('width=device-width')
    expect(content).toContain('viewport-fit=cover')
    expect(content).toContain('interactive-widget=resizes-content')

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })

  test('keeps shell viewport height on browser and standalone CSS branches', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'explicit viewport sizes are exercised once')

    recordBrowserErrors(page)
    await page.addInitScript(themeSeedScript('dark'))
    const environment = await installDeterministicEnvironment(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/app/dashboard')
    await waitForPageReady(page, 'dashboard')
    for (const token of VIEWPORT_HEIGHT_TOKENS) {
      expect(await heightToken(page, token)).toBe('100dvh')
    }

    await page.setViewportSize({ width: 390, height: 844 })
    for (const token of VIEWPORT_HEIGHT_TOKENS) {
      expect(await heightToken(page, token)).toBe('100dvh')
    }

    await page.evaluate(() => document.documentElement.classList.add('la-pluma-standalone'))
    for (const token of VIEWPORT_HEIGHT_TOKENS) {
      expect(
        await heightToken(page, token),
        'la-pluma-standalone 只代理 standalone 的 CSS 分支，不代表 iOS 真机行为',
      ).toBe('100lvh')
    }

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })

  test('keeps a long dialog and its scrollable body inside the viewport', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'explicit viewport sizes are exercised once')

    recordBrowserErrors(page)
    await page.addInitScript(themeSeedScript('dark'))
    const environment = await installDeterministicEnvironment(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/app/training')
    await waitForPageReady(page, 'training')
    await page.getByRole('button', { name: '继续添加', exact: true }).click()

    const dialog = page.getByRole('dialog').filter({ hasText: '添加干员' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('搜索干员名称')).toBeVisible()
    await expectDialogInsideViewport(dialog)

    await page.setViewportSize({ width: 390, height: 520 })
    await expectDialogInsideViewport(dialog)

    const body = dialog.locator('[data-slot="dialog-body"]')
    await expect(body).toBeVisible()
    await expect.poll(() => body.evaluate(element => element.scrollHeight > element.clientHeight))
      .toBe(true)

    await expectDialogInsideViewport(dialog)

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
