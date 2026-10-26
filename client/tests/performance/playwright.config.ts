import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 4317)

export default defineConfig({
  testDir: directory,
  testMatch: '**/*.pw.ts',
  outputDir: '/tmp/la-pluma-performance-results',
  fullyParallel: false,
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
    screenshot: 'off',
    trace: 'off',
  },
  webServer: {
    command: 'node static-server.ts',
    cwd: path.resolve(directory, '../visual'),
    port,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(port), ...(process.env.STATIC_DIST_DIR ? { STATIC_DIST_DIR: process.env.STATIC_DIST_DIR } : {}) },
  },
  projects: [{ name: 'chromium-desktop' }],
})
