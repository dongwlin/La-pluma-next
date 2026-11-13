#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const webRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(webRoot, '../..')
const version = JSON.parse(readFileSync(path.join(webRoot, 'node_modules/@playwright/test/package.json'), 'utf8')).version
const image = `mcr.microsoft.com/playwright:v${version}-noble`

if (!process.env.INTEGRATION_SKIP_BUILD) {
  const build = spawnSync('pnpm', ['--filter', 'la-pluma-next-client', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
} else if (!existsSync(path.join(webRoot, 'dist/index.html'))) {
  throw new Error('apps/web/dist is missing; build before using INTEGRATION_SKIP_BUILD=1')
}

const packageDirectory = readdirSync(path.join(repoRoot, 'node_modules/.pnpm'))
  .find(entry => entry === `playwright@${version}` || entry.startsWith(`playwright@${version}(`))
if (!packageDirectory) throw new Error(`Installed playwright@${version} was not found`)
const cli = `/work/node_modules/.pnpm/${packageDirectory}/node_modules/playwright/cli.js`

const result = spawnSync('docker', [
  'run', '--rm', '--pull=never', '--ipc=host',
  '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-e', 'TZ=Asia/Shanghai', '-e', 'XDG_CACHE_HOME=/tmp', '-e', 'CI',
  '-v', `${repoRoot}:/work`, '-w', '/work', image,
  'node', cli, 'test', '--config', 'apps/web/tests/integration/playwright.config.ts',
  ...process.argv.slice(2),
], { cwd: repoRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
