import { expect, test, type Locator, type Page } from '@playwright/test'
import { createScenarioState, expectScenarioHealthy, installIntegrationScenario } from './harness'

const MIN_TARGET_PX = 44

async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, `${label} 应可见`).not.toBeNull()
  expect(box!.width, `${label} 宽度`).toBeGreaterThanOrEqual(MIN_TARGET_PX)
  expect(box!.height, `${label} 高度`).toBeGreaterThanOrEqual(MIN_TARGET_PX)
}

async function openPreviewSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '打开预览设置', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`预览共享面在 ${viewport.width}px 下保持 44px 触达目标且无横向溢出`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const scenario = createScenarioState()
    scenario.runState = 'succeeded'
    await installIntegrationScenario(page, scenario)
    await page.goto('/app/logs')

    const preview = page.locator('[data-region="monitor"]:visible')
    await expect(preview).toBeVisible()

    for (const name of ['关闭', '快照', '实时']) {
      await expectTouchTarget(preview.getByRole('button', { name, exact: true }), `模式 ${name}`)
    }
    for (const name of ['返回', 'Home', '后台任务', '全屏', '打开预览设置']) {
      await expectTouchTarget(preview.getByRole('button', { name, exact: true }), `工具栏 ${name}`)
    }

    const dialog = await openPreviewSettings(page)

    await expectTouchTarget(dialog.getByRole('button', { name: '关闭对话框', exact: true }), '模态窗关闭')
    await expectTouchTarget(dialog.getByRole('button', { name: '重连预览', exact: true }), '重连预览')
    await expectTouchTarget(dialog.getByRole('button', { name: '关闭', exact: true }), '页脚关闭')
    for (const name of ['启动服务', '连接 Agent', '断开', '重装组件']) {
      await expectTouchTarget(dialog.getByRole('button', { name, exact: true }), `服务 ${name}`)
    }
    for (const name of ['省电画质', '流畅画质', '均衡画质', '清晰画质', '超清画质']) {
      await expectTouchTarget(dialog.getByRole('button', { name, exact: true }), `预设 ${name}`)
    }
    for (const fps of [10, 15, 30, 45, 60, 90, 120]) {
      await expectTouchTarget(dialog.getByRole('button', { name: `${fps} FPS`, exact: true }), `帧率 ${fps}`)
    }

    expect(await preview.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expectScenarioHealthy(page)
  })
}
