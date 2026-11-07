import { expect, test, type Locator } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { apiFixtures, ok, type ApiFixture } from './fixtures'
import { installDeterministicEnvironment, waitForPageReady } from './harness'

const ACCOUNT_HINT = '输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"'
const LAUNCH_HINT = '关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端'
const INFRAST_HINT = '一键轮换使用游戏内队列，并保留无人机、会客室等基础操作'

const infrastFixtures = [
  {
    path: '/agent/config/user/automation-tasks',
    payload: ok({
      taskFlow: [
        {
          id: 'startup-visual-1',
          commandId: 'startup',
          name: '启动游戏',
          description: '启动游戏客户端',
          enabled: true,
          params: { clientType: 'Official', accountName: '' },
        },
        {
          id: 'infrast-visual-2',
          commandId: 'infrast',
          name: '基建换班',
          description: '自动基建换班收菜',
          taskType: 'Infrast',
          enabled: true,
          params: { mode: '0', facility: ['Mfg', 'Recycle', 'AssistantChange'] },
        },
      ],
    }),
  },
  ...apiFixtures,
]

const MALL_HINTS = [
  { key: 'only_buy_discount', label: '只买折扣商品', copy: '仅影响优先购买之外的普通购物' },
  { key: 'reserve_max_credit', label: '保留 300 信用', copy: '普通购物时信用低于 300 就停止购买' },
  { key: 'credit_fight', label: '信用助战', copy: '借助战完成一次 OF-1，以便次日获得更多信用' },
] as const

const mallTaskFixture: ApiFixture = {
  path: '/agent/config/user/automation-tasks',
  payload: ok({
    taskFlow: [
      {
        id: 'mall-visual-1',
        commandId: 'mall',
        name: '信用收支',
        description: '访问好友、收取信用',
        taskType: 'Mall',
        enabled: true,
        params: {
          visit_friends: true,
          shopping: true,
          buy_first: '',
          blacklist: '',
          force_shopping_if_credit_full: false,
          only_buy_discount: false,
          reserve_max_credit: false,
          credit_fight: false,
          formation_index: 0,
        },
      },
    ],
    schedule: { enabled: false, entries: [] },
  }),
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

  test('hangs the mall helper icons right after their labels', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page, {
      fixtures: apiFixtures.map(fixture => (
        fixture.path === mallTaskFixture.path ? mallTaskFixture : fixture
      )),
    })
    await page.goto('/app/automation')
    await page.locator('label[for="automation-mall-visual-1-shopping"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.evaluate(() => document.fonts.ready)

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

    const gaps = new Set<number>()
    for (const hint of MALL_HINTS) {
      const box = await measure(
        page.locator(`label[for="automation-mall-visual-1-${hint.key}"]`),
        page.getByRole('button', { name: `${hint.label}说明`, exact: true }),
      )
      // 标签到 ⓘ 之间只留 inline 的 4px 小间距，而不是被推到行尾。
      expect(box.gap).toBeGreaterThan(0)
      expect(Math.abs(box.gap - 4)).toBeLessThanOrEqual(2)
      expect(Math.abs(box.centerOffset)).toBeLessThanOrEqual(2)
      gaps.add(Math.round(box.gap))
    }
    // 三个开关的图标与标签间距一致，观感与 startup 卡片相同。
    expect(gaps.size).toBe(1)

    for (const hint of MALL_HINTS) {
      const tooltip = page.locator('[role="tooltip"]').filter({ hasText: hint.copy })
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toBeHidden()
      // 常驻说明段落已删除：整页只有默认收起的 tooltip 承载这段文案。
      await expect(page.getByText(hint.copy, { exact: true })).toHaveCount(1)
    }

    const discountHint = page.getByRole('button', { name: '只买折扣商品说明', exact: true })
    const discountTooltip = page.locator('[role="tooltip"]').filter({ hasText: MALL_HINTS[0].copy })
    await discountHint.hover()
    await expect(discountTooltip).toBeVisible()
    await expect(discountTooltip).toHaveText(MALL_HINTS[0].copy)
    await page.mouse.move(4, 4)
    await expect(discountTooltip).toBeHidden()

    const creditFightHint = page.getByRole('button', { name: '信用助战说明', exact: true })
    const creditFightTooltip = page.locator('[role="tooltip"]').filter({ hasText: MALL_HINTS[2].copy })
    await creditFightHint.focus()
    await expect(creditFightHint).toBeFocused()
    await expect(creditFightTooltip).toBeVisible()
    await expect(creditFightTooltip).toHaveText(MALL_HINTS[2].copy)
    await page.keyboard.press('Escape')
    await expect(creditFightTooltip).toBeHidden()

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

  test('shows the infrast shift-mode hint beside the label and drops the facility hint line', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page, { fixtures: infrastFixtures })
    await page.goto('/app/automation')
    await waitForPageReady(page, 'automation')

    await page.locator('button[aria-controls="automation-task-editor"]')
      .filter({ hasText: '基建换班' })
      .click()

    const shiftModeHint = page.getByRole('button', { name: '换班模式说明', exact: true })
    await expect(shiftModeHint).toBeVisible()

    const shiftModeTooltip = page.locator('[role="tooltip"]').filter({ hasText: INFRAST_HINT })
    await expect(shiftModeTooltip).toHaveCount(1)
    await expect(shiftModeTooltip).toBeHidden()

    await shiftModeHint.hover()
    await expect(shiftModeTooltip).toBeVisible()
    await expect(shiftModeTooltip).toHaveText(INFRAST_HINT)

    await page.mouse.move(4, 4)
    await expect(shiftModeTooltip).toBeHidden()

    await shiftModeHint.focus()
    await expect(shiftModeHint).toBeFocused()
    await expect(shiftModeTooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shiftModeTooltip).toBeHidden()

    // 设施选择下方的常驻提示整行删除，页面里不再出现这段文案或残留图标。
    await expect(page.getByText('选择要换班的设施')).toHaveCount(0)
    await expect(page.getByText(INFRAST_HINT, { exact: true })).toHaveCount(1)

    // 设施网格与副手换人保持完整，勾选状态仍来自配置。
    const facilityFieldset = page.locator('fieldset').filter({ has: page.getByRole('checkbox', { name: '副手换人' }) })
    await expect(facilityFieldset.getByRole('checkbox')).toHaveCount(11)
    await expect(page.getByRole('checkbox', { name: '制造站' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: '回收站' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: '副手换人' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: '贸易站' })).not.toBeChecked()

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
