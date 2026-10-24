import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4300)

/**
 * 视觉基线 harness 配置。
 *
 * 运行环境钉死：本 harness 只允许在 mcr.microsoft.com/playwright 官方镜像
 * （版本与 @playwright/test 完全一致）内运行，通过仓库根的
 * `pnpm visual` / `pnpm visual:update` 包装脚本进入。字体与浏览器由此
 * 构造为"本地 = CI"，基线截图为 Linux/Chromium 专属，换环境必须重新生成。
 */
export default defineConfig({
  testDir: __dirname,
  // .pw.ts 后缀：既与 vitest 的默认 include（*.test.* / *.spec.*）隔离，
  // 也避免 vitest 误把视觉测试当单测执行。
  testMatch: '**/*.pw.ts',
  outputDir: path.resolve(__dirname, '..', '..', 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  timeout: 60_000,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{projectName}-{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 动效：模拟系统级"减弱动态效果"。MotionConfig reducedMotion="user"
    // 使 framer-motion 全部动画即时完成；CSS 动画/过渡由 spec 里的
    // 注入样式一并禁用（见 app.pw.ts）。
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    deviceScaleFactor: 1,
    screenshot: 'off',
    trace: 'off',
  },
  webServer: {
    command: `node static-server.mjs`,
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
})
