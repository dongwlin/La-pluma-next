#!/usr/bin/env node
/** 真实 Chromium 的跨页集成入口。使用既有、已审核的 Playwright 镜像，不拉取依赖。 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'client')
const version = JSON.parse(readFileSync(path.join(clientRoot, 'node_modules/@playwright/test/package.json'), 'utf8')).version
const image = `mcr.microsoft.com/playwright:v${version}-noble`

if (!process.env.INTEGRATION_SKIP_BUILD) {
  const build = spawnSync('pnpm', ['--filter', 'la-pluma-next-client', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
} else if (!existsSync(path.join(clientRoot, 'dist/index.html'))) {
  throw new Error('client/dist is missing; build before using INTEGRATION_SKIP_BUILD=1')
}

const packageDirectory = readdirSync(path.join(repoRoot, 'node_modules/.pnpm'))
  .find(entry => entry === `playwright@${version}` || entry.startsWith(`playwright@${version}(`))
if (!packageDirectory) throw new Error(`Installed playwright@${version} was not found`)
const cli = `/work/node_modules/.pnpm/${packageDirectory}/node_modules/playwright/cli.js`

const result = spawnSync('docker', [
  'run', '--rm', '--pull=never', '--ipc=host', '--network=host',
  '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-e', 'TZ=Asia/Shanghai', '-e', 'XDG_CACHE_HOME=/tmp',
  '-v', `${repoRoot}:/work`, '-w', '/work', image,
  'node', cli, 'test', '--config', 'client/tests/integration/playwright.config.ts',
  ...process.argv.slice(2),
], { cwd: repoRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
