#!/usr/bin/env node
/** Fixed-browser interaction sampling. Run from the repository root:
 * node client/scripts/performance-docker.ts
 * PERFORMANCE_SKIP_BUILD=1 node client/scripts/performance-docker.ts
 * No dependency installation, image pull, snapshot update, or production instrumentation.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'client')
const version = JSON.parse(readFileSync(path.join(clientRoot, 'node_modules/@playwright/test/package.json'), 'utf8')).version
const image = `mcr.microsoft.com/playwright:v${version}-noble`

function command(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${cmd} exited ${result.status}`)
  return result.stdout.trim()
}

if (!process.env.PERFORMANCE_SKIP_BUILD) {
  const build = spawnSync('pnpm', ['--filter', 'la-pluma-next-client', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
} else if (!existsSync(path.join(clientRoot, 'dist/index.html'))) {
  throw new Error('client/dist is missing; build before using PERFORMANCE_SKIP_BUILD=1')
}

const packageDirectory = readdirSync(path.join(repoRoot, 'node_modules/.pnpm'))
  .find(entry => entry === `playwright@${version}` || entry.startsWith(`playwright@${version}(`))
if (!packageDirectory) throw new Error(`Installed playwright@${version} was not found`)
const cli = `/work/node_modules/.pnpm/${packageDirectory}/node_modules/playwright/cli.js`

function digestFiles(files: string[]) {
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(`${path.relative(repoRoot, file)}\0`)
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

const distFiles: string[] = []
function collect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(file)
    else distFiles.push(file)
  }
}
collect(path.join(clientRoot, 'dist'))

// --pull=never ensures this entry point uses the existing, reviewed environment.
const metadata = {
  sourceCommit: command('git', ['rev-parse', 'HEAD']),
  sourceFilesDirty: command('git', ['status', '--porcelain', '--', 'client/src', 'client/vite.config.ts', 'pnpm-lock.yaml']) !== '',
  distSha256: digestFiles(distFiles),
  fixtureSha256: digestFiles([
    path.join(clientRoot, 'tests/visual/fixtures.ts'),
    path.join(clientRoot, 'tests/performance/fixtures.ts'),
  ]),
  harnessSha256: digestFiles([
    path.join(clientRoot, 'scripts/performance-docker.ts'),
    path.join(clientRoot, 'tests/performance/playwright.config.ts'),
    path.join(clientRoot, 'tests/performance/interactions.pw.ts'),
    path.join(clientRoot, 'tests/visual/harness.ts'),
    path.join(clientRoot, 'tests/visual/static-server.ts'),
  ]),
  playwrightVersion: version,
  image,
  imageId: command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]),
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length },
}

const result = spawnSync('docker', [
  'run', '--rm', '--pull=never', '--ipc=host', '--network=host',
  '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-e', 'TZ=Asia/Shanghai', '-e', 'XDG_CACHE_HOME=/tmp',
  '-e', `PERFORMANCE_METADATA=${JSON.stringify(metadata)}`,
  '-v', `${repoRoot}:/work`, '-w', '/work', image,
  'node', cli, 'test', '--config', 'client/tests/performance/playwright.config.ts',
  ...process.argv.slice(2),
], { cwd: repoRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
