import { expect, test, type Page } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { installDeterministicEnvironment, waitForPageReady } from './harness'

const ACCOUNT_HINT = '输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"'
const LAUNCH_HINT = '关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端'

const FIGHT_HINTS: Array<[string, string]> = [
  ['关卡计划说明', '使用 HD-数字代表当前活动关卡；置顶关卡会优先执行。次数为该关卡的累计作战局数上限（连战中的每一局都计 1），留空表示不限制局数'],
  ['掉落目标说明', '任一物品达到目标数量后停止；格式为物品 ID=数量，多个目标用逗号分隔'],
  ['理智药说明', '使用理智药数量'],
  ['临期药天数说明', '使用将在指定天数内过期的理智药；0 表示不使用临期药'],
  ['源石说明', '使用源石数量'],
  ['连战说明', '本任务所有关卡共用的连战倍率，范围 -1 至 10（旧资源只支持 -1 至 6）；与各关卡次数同时生效：固定倍率时次数少于倍率不会开始任何一局（0 局）；指定倍率不能整除剩余次数时最后一轮连战不会开始，实际局数会少于次数；选“自动”会按剩余次数调整'],
  ['闪退重启说明', '选择客户端后，游戏闪退时会自动重新启动。'],
  ['葛朗台碎石模式说明', '使用源石前等待自然恢复 1 点理智，尽量减少碎石浪费。'],
]

const selectFightTask = async (page: Page) => {
  await page.locator('[aria-controls="automation-task-editor"]').filter({ hasText: '理智作战' }).click()
  await expect(page.getByRole('button', { name: '关卡计划说明', exact: true })).toBeVisible()
}

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

  test('reveals the fight helper texts on hover and focus without persistent paragraphs', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page)
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')
    await selectFightTask(page)

    // 区块级提示位于「关卡计划」标题行内、关卡数量徽标右侧。
    const stageHint = page.getByRole('button', { name: '关卡计划说明', exact: true })
    const stageTitle = page.locator('.automation-stage-editor-title')
    await expect(stageTitle).toContainText('关卡计划')
    await expect(stageTitle).toContainText('1 个关卡')
    expect(await stageHint.evaluate((trigger) => {
      const badge = trigger.previousElementSibling
      return badge?.tagName === 'SPAN' && badge.textContent === '1 个关卡'
    })).toBe(true)

    for (const [name, copy] of FIGHT_HINTS.slice(0, 6)) {
      const trigger = page.getByRole('button', { name, exact: true })
      const tooltip = page.locator('[role="tooltip"]').filter({ hasText: copy })
      await expect(trigger).toBeVisible()
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toBeHidden()

      await trigger.hover()
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toHaveText(copy)

      await page.mouse.move(4, 4)
      await expect(tooltip).toBeHidden()

      await trigger.focus()
      await expect(trigger).toBeFocused()
      await expect(tooltip).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(tooltip).toBeHidden()
    }

    // 高级设置里的两条常驻说明同样收进了图标提示。
    await page.locator('details summary').filter({ hasText: '高级设置' }).first().click()

    for (const [name, copy] of FIGHT_HINTS.slice(6)) {
      const trigger = page.getByRole('button', { name, exact: true })
      const tooltip = page.locator('[role="tooltip"]').filter({ hasText: copy })
      await expect(trigger).toBeVisible()
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toBeHidden()

      await trigger.hover()
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toHaveText(copy)

      await page.keyboard.press('Escape')
      await expect(tooltip).toBeHidden()
    }

    // 说明文字只存在于默认收起的 tooltip 里，页面上不再有常驻段落副本。
    for (const [, copy] of FIGHT_HINTS) {
      await expect(page.getByText(copy, { exact: true })).toHaveCount(1)
    }

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
