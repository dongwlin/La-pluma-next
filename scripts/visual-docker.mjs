#!/usr/bin/env node
// 视觉基线运行入口：把"截图生成与比对"统一钉进 mcr.microsoft.com/playwright
// 官方镜像（版本 = client 实际安装的 @playwright/test 版本），使本地与 CI 的
// 字体、浏览器完全一致——一致性是构造出来的，不是碰运气。
//
// 前置：镜像需要 chromium 之外无其他依赖；仓库（含 node_modules 与 dist）挂载进容器。
// 用法：
//   pnpm visual            # 比对模式（CI / 日常验收）
//   pnpm visual:update     # 重新生成基线截图
//   pnpm visual -- --grep "dashboard"   # 透传任意 playwright 参数
// 环境变量：
//   PLAYWRIGHT_IMAGE   覆盖镜像（默认按已装版本拼 v<version>-noble）
//   VISUAL_SKIP_BUILD  跳过容器外的 client 构建
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientRoot = path.join(repoRoot, 'client')
const version = JSON.parse(
  readFileSync(path.join(clientRoot, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
).version

const image = process.env.PLAYWRIGHT_IMAGE || `mcr.microsoft.com/playwright:v${version}-noble`
const passthroughArgs = process.argv.slice(2)

// 基线截图只针对构建产物（与生产一致），先在宿主机构建（esbuild/rollup 的
// 原生二进制按宿主机环境安装，不在容器内复用）。
if (!process.env.VISUAL_SKIP_BUILD) {
  const build = spawnSync('pnpm', ['--filter', 'la-pluma-next-client', 'build'], {
    stdio: 'inherit',
    cwd: repoRoot,
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
} else if (!existsSync(path.join(clientRoot, 'dist', 'index.html'))) {
  console.error('client/dist 不存在：请先运行 `pnpm --filter la-pluma-next-client build`。')
  process.exit(1)
}

// 解析 playwright CLI 的真实路径：pnpm workspace 把 playwright 包提升在
// 根 node_modules/.pnpm 虚拟仓库（client 的 .bin/playwright 是 shell shim，
// 不能作为 node 入口）。按已装版本精确定位。
function resolvePlaywrightCli(version) {
  const storeDir = path.join(repoRoot, 'node_modules', '.pnpm')
  if (existsSync(storeDir)) {
    for (const entry of readdirSync(storeDir)) {
      if (entry === `playwright@${version}` || entry.startsWith(`playwright@${version}(`)) {
        return path.join(storeDir, entry, 'node_modules', 'playwright', 'cli.js')
      }
    }
  }
  // 非 pnpm 布局的兜底。
  return createRequire(path.join(clientRoot, 'package.json')).resolve('playwright/cli.js', {
    paths: [path.join(repoRoot, 'node_modules', `.pnpm`, `playwright@${version}`, 'node_modules')],
  })
}

const playwrightCli = resolvePlaywrightCli(version)
if (!existsSync(playwrightCli)) {
  console.error(`未找到 playwright cli：${playwrightCli}`)
  process.exit(1)
}
const playwrightCliRel = path.relative(repoRoot, playwrightCli).replaceAll('\\', '/')
if (playwrightCliRel.startsWith('..')) {
  console.error(`playwright cli 不在仓库内：${playwrightCli}`)
  process.exit(1)
}

const dockerArgs = [
  'run',
  '--rm',
  // Chromium 推荐共享宿主 /dev/shm，避免渲染进程共享内存不足。
  '--ipc=host',
  // 与 CI（Linux runner）一致的宿主网络；容器内直接访问宿主回环地址不需要。
  '--network=host',
  '-e', 'TZ=Asia/Shanghai',
  '-e', 'CI',
  '-v', `${repoRoot}:/work`,
  '-w', '/work',
  image,
  'node', `/work/${playwrightCliRel}`,
  'test',
  '--config', 'client/tests/visual/playwright.config.ts',
  ...passthroughArgs,
]

console.log(`[visual] ${image}`)
const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' })
process.exit(result.status ?? 1)
