import { expect, test, type Locator } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { installDeterministicEnvironment, waitForPageReady } from './harness'

const ACCOUNT_HINT = '输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"'
const LAUNCH_HINT = '关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端'

test.describe('automation field hints', () => {
  test.beforeEach(async ({ page }) => {
    recordBrowserErrors(page)
  })

  test('reveals the startup helper texts on hover and focus', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page)
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')

    const accountHint = page.getByRole('button', { name: '切换账号说明', exact: true })
    const launchHint = page.getByRole('button', { name: '启动游戏客户端说明', exact: true })
    await expect(accountHint).toBeVisible()
    await expect(launchHint).toBeVisible()

    const accountTooltip = page.locator('[role="tooltip"]').filter({ hasText: ACCOUNT_HINT })
    const launchTooltip = page.locator('[role="tooltip"]').filter({ hasText: LAUNCH_HINT })
    await expect(accountTooltip).toHaveCount(1)
    await expect(launchTooltip).toHaveCount(1)
    await expect(accountTooltip).toBeHidden()
    await expect(launchTooltip).toBeHidden()

    await accountHint.hover()
    await expect(accountTooltip).toBeVisible()
    await expect(accountTooltip).toHaveText(ACCOUNT_HINT)

    await page.mouse.move(4, 4)
    await expect(accountTooltip).toBeHidden()

    await launchHint.focus()
    await expect(launchHint).toBeFocused()
    await expect(launchTooltip).toBeVisible()
    await expect(launchTooltip).toHaveText(LAUNCH_HINT)
    await page.keyboard.press('Escape')
    await expect(launchTooltip).toBeHidden()

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })

  test('keeps the revealed hint inside the viewport and above the panels', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page)
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')

    const accountHint = page.getByRole('button', { name: '切换账号说明', exact: true })
    const accountTooltip = page.locator('[role="tooltip"]').filter({ hasText: ACCOUNT_HINT })

    await accountHint.hover()
    await expect(accountTooltip).toBeVisible()

    const viewport = page.viewportSize()!
    const box = await accountTooltip.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)

    // 提示层挂在 body 上而不是面板里，面板的圆角裁切不会截断它。
    expect(await accountTooltip.evaluate(element => element.parentElement === document.body)).toBe(true)

    // 说明文字不再有常驻段落：整页只有 tooltip 一处承载它。
    await expect(page.getByText(ACCOUNT_HINT, { exact: true })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByText(LAUNCH_HINT, { exact: true })).toBeHidden()

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })

  test('hangs the launch hint right after its label instead of the row end', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page)
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')

    const measure = async (label: Locator, hint: Locator) => {
      const labelBox = await label.boundingBox()
      const hintBox = await hint.boundingBox()
      expect(labelBox).not.toBeNull()
      expect(hintBox).not.toBeNull()
      return {
        gap: hintBox!.x - (labelBox!.x + labelBox!.width),
        centerOffset: hintBox!.y + hintBox!.height / 2 - (labelBox!.y + labelBox!.height / 2),
      }
    }

    const account = await measure(
      page.locator('label[for="automation-startup-visual-1-accountName"]'),
      page.getByRole('button', { name: '切换账号说明', exact: true }),
    )
    const launch = await measure(
      page.locator('label[for="automation-startup-visual-1-start_game_enabled"]'),
      page.getByRole('button', { name: '启动游戏客户端说明', exact: true }),
    )

    // 标签到 ⓘ 按钮之间只留 inline 的小间距，而不是被推到行尾。
    expect(Math.abs(launch.gap - 4)).toBeLessThanOrEqual(2)
    expect(launch.gap).toBeGreaterThan(0)
    // 与「切换账号」旁的 ⓘ 保持同样的间距与垂直居中。
    expect(Math.abs(launch.gap - account.gap)).toBeLessThanOrEqual(1)
    expect(Math.abs(launch.centerOffset)).toBeLessThanOrEqual(2)
    expect(Math.abs(account.centerOffset)).toBeLessThanOrEqual(2)

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
