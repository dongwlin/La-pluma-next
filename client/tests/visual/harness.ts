import { expect, type Page, type Route } from '@playwright/test'
import {
  apiFixtures,
  EXTERNAL_IMAGE_HOSTS,
  FIXED_NOW,
  PLACEHOLDER_PNG_BASE64,
  type ApiFixture,
} from './fixtures'

/**
 * 视觉基线 harness 的公共部分：固定数据、外部资源、时间、动效与主题种子。
 *
 * 确定性手段：
 * 1. 数据解耦 — page.route 拦截 /api/**，全部返回 fixtures.ts 固定数据；
 *    未匹配的 /api 请求视为 harness 缺口直接判失败，防止静默假状态。
 * 2. 外部资源 — raw.githubusercontent.com 头像/物品图返回固定占位 PNG；
 *    Service Worker 注册在文档起点被替换为永久挂起的 promise，
 *    基线环境无 SW、也无 PWA 注册提示。
 * 3. 时间 — page.clock.setFixedTime 固定 Date 到 FIXED_NOW（2026-10-24
 *    04:00 UTC+8，明日方舟每日重置时刻），日期敏感内容不随当天变化。
 *    不用 clock.install 假定时钟：它会冻结 requestAnimationFrame，
 *    让 framer-motion 停在初始帧、Playwright 的可见性轮询停摆。
 *    会随真实时间累积的数据（概览温度历史，5s 轮询）改为只应答首次
 *    请求、后续请求 abort，从机制上消除采样数漂移。
 * 4. 动效 — reducedMotion: 'reduce'（MotionConfig reducedMotion="user"
 *    据此即时完成动画）+ 文档级注入禁用 CSS 动画/过渡的样式，双保险。
 * 5. 主题 — 预置 zustand persist 的 localStorage（ui-storage），与
 *    index.html 内联启动脚本使用同一 key，首帧即目标主题，无闪变。
 */

export const THEMES = ['dark', 'light'] as const
export type Theme = (typeof THEMES)[number]

export const READY_MARKER: Record<string, { text?: string; input?: string }> = {
  dashboard: { text: '春厦限定纪行' },
  automation: { text: '启动游戏客户端' },
  combat: { input: 'maa://10086' },
  roguelike: { input: 'Mizuki' },
  training: { text: '艾雅法拉' },
  logs: { text: '任务执行完成' },
  statistics: { text: '能天使' },
  config: { text: 'v5.12.3' },
}

/** 主题种子：与 shared/stores/uiStore.ts 的 persist key/结构保持一致。 */
export function themeSeedScript(theme: Theme) {
  return `
    localStorage.setItem('ui-storage', JSON.stringify({
      state: { theme: ${JSON.stringify(theme)} },
      version: 0,
    }))
  `
}

/**
 * 禁用 CSS 动画/过渡的兜底样式（framer-motion 已由 reduced motion 覆盖，
 * 这里覆盖纯 CSS 的 keyframes/transition，避免截图瞬间处于动画中间态）。
 */
const MOTION_FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`

const NO_SW_SCRIPT = `
  // 阻断 service worker 注册（单页应用在基线环境下无需离线缓存）。
  // 注册 promise 永久挂起：既不触发 PWAInstallPrompt 的注册失败提示，
  // 也不触发 offlineReady 提示（success 消息 1.5s 自动收起会造成时序抖动）。
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => new Promise(() => {})
  }
`

function matchFixture(method: string, pathname: string): ApiFixture['payload'] | undefined {
  for (const fixture of apiFixtures) {
    if ((fixture.method ?? 'GET') !== method) continue
    const pattern = fixture.path.split('/').filter(Boolean)
    const actual = pathname.split('/').filter(Boolean)
    if (pattern.length !== actual.length) continue
    const matched = pattern.every((segment, index) =>
      segment.startsWith(':') ? actual[index] !== '' : segment === actual[index])
    if (matched) return fixture.payload
  }
  return undefined
}

export async function installDeterministicEnvironment(page: Page) {
  const unmatchedApiCalls: string[] = []

  await page.addInitScript(NO_SW_SCRIPT)
  await page.addInitScript(`
    const style = document.createElement('style')
    style.textContent = ${JSON.stringify(MOTION_FREEZE_CSS)}
    document.documentElement.appendChild(style)
  `)

  // 双保险：即便 SW 脚本请求发生，也直接 404（register 已在文档起点被替换为挂起 promise）。
  await page.route('**/sw.js', route => route.fulfill({ status: 404, body: 'sw disabled' }))

  // 外部游戏资源图（头像/物品图标）：返回固定占位 PNG。
  for (const host of EXTERNAL_IMAGE_HOSTS) {
    await page.route(`https://${host}/**`, (route: Route) => {
      void route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'),
      })
    })
  }

  // /api/**：返回 fixture；未匹配 = harness 缺口，记录并稍后判失败。
  let deviceStatsCalls = 0
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname.replace(/^\/api/, '') || '/'
    const payload = matchFixture(request.method(), pathname)
    if (payload === undefined) {
      unmatchedApiCalls.push(`${request.method()} /api${pathname}`)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
      return
    }
    // 温度历史随每次轮询累积（5s 间隔）：只应答挂载后的首次请求，
    // 后续请求 abort（组件 catch 后保留既有样本），截图不受真实耗时影响。
    if (pathname === '/agent/device-stats') {
      deviceStatsCalls += 1
      if (deviceStatsCalls > 1) {
        await route.abort()
        return
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })

  // 时间固定：Date 从首帧起固定，定时器照常运行（详见文件头说明）。
  await page.clock.setFixedTime(FIXED_NOW)

  return {
    assertNoUnmatchedApi() {
      expect(unmatchedApiCalls, '未匹配 fixture 的 /api 请求（需补 fixtures.ts）').toEqual([])
    },
  }
}

export async function waitForPageReady(page: Page, tab: string) {
  const marker = READY_MARKER[tab]
  if (!marker) throw new Error(`缺少 ${tab} 的就绪标记`)
  if (marker.text) {
    await page.getByText(marker.text, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 })
  } else if (marker.input) {
    await page.waitForFunction(
      expected => Array.from(document.querySelectorAll('input')).some(input => input.value === expected),
      marker.input,
      { timeout: 20_000 },
    )
  }
  await page.evaluate(() => document.fonts.ready)
}
