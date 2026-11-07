import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoBrowserErrors, recordBrowserErrors } from './browser-errors'
import { apiFixtures, ok } from './fixtures'
import { installDeterministicEnvironment, waitForPageReady } from './harness'

const ACCOUNT_HINT = '输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"'
const LAUNCH_HINT = '关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端'

const RECRUIT_HINTS = {
  '无许可时仍刷新说明': '招聘许可耗尽后，仍会使用可用刷新次数',
  '招募星级说明': '支持 6 星自动公招；勾选 6 星后会保留高价值标签并自动选择对应组合',
  '确认星级说明': '建议至少保留 5/6 星确认，避免高价值标签被跳过；不勾选任何星级时只计算标签，不会确认招募',
  '招募次数说明': '设为 0 时只计算标签，不执行招募',
  '保留标签说明': '识别到任一标签时保留该公招槽位，多个标签用逗号分隔',
  '3 星保留招聘许可说明': '自动确认 3 星时保留的招聘许可数量；剩余许可小于等于该值时跳过 3 星招募，0 表示不保留',
} as const

const RECRUIT_ADVANCED_HINTS = {
  '多选 Tag 策略说明': '默认行为只选能组成有效组合的 Tag；“选 3 个 Tags”会尽量凑满 3 个；“尽量多选高星 Tag 组合”优先保留高星组合，可能包含冲突标签。',
  '三星首选说明': '仅在三星组合中优先选择，多个标签用逗号分隔。',
  '招募时长说明': '可设置 60 至 540 分钟，按 10 分钟调整；五星和六星固定为 540 分钟。',
} as const

const recruitFixtures = [
  {
    path: '/agent/config/user/automation-tasks',
    payload: ok({
      taskFlow: [
        {
          id: 'recruit-visual-1',
          commandId: 'recruit',
          name: '自动公招',
          description: '自动公开招募',
          taskType: 'Recruit',
          enabled: true,
          params: {
            refresh: true,
            force_refresh: true,
            select: [4, 5, 6],
            confirm: [3, 4],
            times: '4',
            set_time: true,
            expedite: false,
            expedite_times: 0,
            preserve_tags: '支援机械',
            first_tags: '',
            extra_tags_mode: 0,
            level3_recruitment_permit_reserve: 0,
            recruitment_time: { '3': 540, '4': 540 },
          },
        },
      ],
    }),
  },
  ...apiFixtures,
]

const labelTextRect = async (page: Page, legend: Locator) => {
  const handle = await legend.elementHandle()
  return page.evaluate((element) => {
    const textNode = element?.querySelector('span')?.firstChild
    if (!textNode) return null
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, handle)
}

const hintGap = async (label: Locator, hint: Locator) => {
  const labelBox = await label.boundingBox()
  const hintBox = await hint.boundingBox()
  expect(labelBox).not.toBeNull()
  expect(hintBox).not.toBeNull()
  return {
    gap: hintBox!.x - (labelBox!.x + labelBox!.width),
    centerOffset: hintBox!.y + hintBox!.height / 2 - (labelBox!.y + labelBox!.height / 2),
  }
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

  test('moves the recruit helper texts beside their labels and keeps the advanced section', async ({ page }) => {
    const environment = await installDeterministicEnvironment(page, { fixtures: recruitFixtures })
    await page.goto('/app/automation')
    await page.getByText('自动公招', { exact: false }).first().waitFor({ state: 'visible' })
    await page.evaluate(() => document.fonts.ready)

    for (const [name, copy] of Object.entries(RECRUIT_HINTS)) {
      const hint = page.getByRole('button', { name, exact: true })
      await expect(hint).toBeVisible()
      const tooltip = page.locator('[role="tooltip"]').filter({ hasText: copy })
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toBeHidden()
      // 说明文字不再有常驻段落：整页只有 tooltip 一处承载它。
      await expect(page.getByText(copy, { exact: true })).toHaveCount(1)
    }

    const forceRefreshHint = page.getByRole('button', { name: '无许可时仍刷新说明', exact: true })
    await forceRefreshHint.hover()
    await expect(page.locator('[role="tooltip"]').filter({ hasText: RECRUIT_HINTS['无许可时仍刷新说明'] })).toBeVisible()
    await page.mouse.move(4, 4)

    const timesHint = page.getByRole('button', { name: '招募次数说明', exact: true })
    await timesHint.focus()
    await expect(timesHint).toBeFocused()
    await expect(page.locator('[role="tooltip"]').filter({ hasText: RECRUIT_HINTS['招募次数说明'] })).toBeVisible()
    await page.keyboard.press('Escape')

    const checkboxRow = await hintGap(
      page.locator('label[for="automation-recruit-visual-1-force_refresh"]'),
      forceRefreshHint,
    )
    const numberRow = await hintGap(
      page.locator('label[for="automation-recruit-visual-1-times"]'),
      timesHint,
    )
    const longLabelRow = await hintGap(
      page.locator('label[for="automation-recruit-visual-1-level3_recruitment_permit_reserve"]'),
      page.getByRole('button', { name: '3 星保留招聘许可说明', exact: true }),
    )
    const starLegend = page.locator('#automation-task-editor legend').filter({ hasText: '招募星级' })
    const starText = await labelTextRect(page, starLegend)
    const starHintBox = await page.getByRole('button', { name: '招募星级说明', exact: true }).boundingBox()
    expect(starText).not.toBeNull()
    expect(starHintBox).not.toBeNull()

    // 图标紧贴标签文字（4–6px），而不是被推到行尾。
    for (const measured of [checkboxRow, numberRow, longLabelRow]) {
      expect(measured.gap).toBeGreaterThanOrEqual(3)
      expect(measured.gap).toBeLessThanOrEqual(6)
      expect(Math.abs(measured.centerOffset)).toBeLessThanOrEqual(2)
    }
    expect(starHintBox!.x - (starText!.x + starText!.width)).toBeGreaterThanOrEqual(3)
    expect(starHintBox!.x - (starText!.x + starText!.width)).toBeLessThanOrEqual(6)

    const details = page.locator('#automation-task-editor details').first()
    const summary = details.locator('summary')
    for (const name of Object.keys(RECRUIT_ADVANCED_HINTS)) {
      await expect(page.getByRole('button', { name, exact: true })).toBeHidden()
    }

    await summary.click()
    await expect(details).toHaveAttribute('open', '')
    for (const [name, copy] of Object.entries(RECRUIT_ADVANCED_HINTS)) {
      const hint = page.getByRole('button', { name, exact: true })
      await expect(hint).toBeVisible()
      await expect(page.getByText(copy, { exact: true })).toHaveCount(1)
      await expect(page.getByText(copy, { exact: true })).toBeHidden()
    }

    const advancedHint = page.getByRole('button', { name: '多选 Tag 策略说明', exact: true })
    await advancedHint.hover()
    await expect(page.locator('[role="tooltip"]').filter({ hasText: RECRUIT_ADVANCED_HINTS['多选 Tag 策略说明'] }))
      .toBeVisible()
    await page.mouse.move(4, 4)

    const themeFieldset = page.locator('#automation-task-editor fieldset').last()
    const themeText = await labelTextRect(page, themeFieldset.locator('legend'))
    const themeHintBox = await page.getByRole('button', { name: '招募时长说明', exact: true }).boundingBox()
    expect(themeText).not.toBeNull()
    expect(themeHintBox).not.toBeNull()
    expect(themeHintBox!.x - (themeText!.x + themeText!.width)).toBeGreaterThanOrEqual(3)
    expect(themeHintBox!.x - (themeText!.x + themeText!.width)).toBeLessThanOrEqual(6)

    await summary.click()
    await expect(details).not.toHaveAttribute('open', '')
    for (const name of Object.keys(RECRUIT_ADVANCED_HINTS)) {
      await expect(page.getByRole('button', { name, exact: true })).toBeHidden()
    }

    environment.assertNoUnmatchedApi()
    await expectNoBrowserErrors(page)
  })
})
