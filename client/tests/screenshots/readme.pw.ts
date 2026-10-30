import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectNoBrowserErrors, recordBrowserErrors } from '../visual/browser-errors'
import { installDeterministicEnvironment, themeSeedScript } from '../visual/harness'
import { readmeApiFixtures } from './fixtures'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_NAMES: Record<string, string> = {
  web: 'automation-web-light.png',
  mobile: 'automation-mobile-light.png',
}
// 与 operator-quotes 使用的外部头像 URL 一致；截图时用本地资产替代灰色占位图。
const AMIYA_AVATAR_URL =
  'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/char_002_amiya.png'
const AMIYA_AVATAR = readFileSync(path.resolve(__dirname, 'assets', 'amiya.png'))

async function waitForImages(page: Page) {
  await page.evaluate(async () => {
    const pending = Array.from(document.images).filter(image => !image.complete)
    await Promise.all(pending.map(image => new Promise<void>(resolve => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })))
  })
}

test('README automation screenshot', async ({ page }, testInfo) => {
  const outputName = OUTPUT_NAMES[testInfo.project.name]
  if (!outputName) throw new Error(`未配置项目 ${testInfo.project.name} 的输出文件名`)

  recordBrowserErrors(page)
  await page.addInitScript(themeSeedScript('light'))
  const environment = await installDeterministicEnvironment(page, { fixtures: readmeApiFixtures })
  // 侧栏身份固定为阿米娅，并用仓库内的头像资产替代视觉基线的灰色占位图。
  await page.route(AMIYA_AVATAR_URL, route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: AMIYA_AVATAR,
  }))

  await page.goto('/app/automation')

  // 等任务流、定时设置和状态指示器都完成固定数据渲染，避免截到加载中间态。
  await page.getByText('任务流程', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByText('7/7', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByText('关闭游戏', { exact: true }).first().waitFor({ state: 'visible' })
  await page.getByRole('group', { name: '第 3 个执行时间' }).waitFor({ state: 'visible' })
  await page.getByText('博士，情报已经同步完毕', { exact: false }).first().waitFor({ state: 'visible' })
  await expect(page.getByText('最近执行', { exact: true })).toHaveCount(0)

  if (testInfo.project.name === 'web') {
    // 移动端不渲染侧栏身份，只在桌面截图校验阿米娅头像已真正解码。
    const sidebarIdentity = page.getByLabel('阿米娅：今天也请多指教')
    await sidebarIdentity.waitFor({ state: 'visible' })
    await expect.poll(
      () => sidebarIdentity.locator('img').evaluate(image => image.complete && image.naturalWidth > 0),
    ).toBe(true)
  }

  await page.evaluate(() => document.fonts.ready)
  await waitForImages(page)
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  // 先确认 fixture 与浏览器错误都干净，避免失败运行仍覆盖入库图片。
  environment.assertNoUnmatchedApi()
  await expectNoBrowserErrors(page)

  await page.screenshot({
    path: path.resolve(__dirname, '..', '..', '..', 'screenshots', outputName),
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  })
})
