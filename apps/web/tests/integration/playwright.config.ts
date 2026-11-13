import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 4318)

export default defineConfig({
  testDir: directory,
  testMatch: '**/*.pw.ts',
  outputDir: path.resolve(directory, '..', '..', 'integration-artifacts'),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  reporter: [['line']],
  timeout: 90_000,
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    baseURL: `http://127.0.0.1:${port}`,
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node static-server.ts',
    cwd: path.resolve(directory, '../visual'),
    port,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(port) },
  },
  projects: [{ name: 'chromium-desktop' }],
})
