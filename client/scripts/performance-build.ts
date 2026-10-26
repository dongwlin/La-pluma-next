#!/usr/bin/env node
/** Build an exported, immutable git source with a shared test-only profiling overlay. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile } from 'vite'
import { createProfilingOverlay } from '../tests/performance/profiling-overlay.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [ref, sourceRootArgument, distArgument] = process.argv.slice(2)
if (!ref || !sourceRootArgument || !distArgument) {
  throw new Error('Usage: node client/scripts/performance-build.ts <commit> <new-source-directory> <dist-directory>')
}
const sourceRoot = path.resolve(sourceRootArgument)
const dist = path.resolve(distArgument)
if (!sourceRoot.startsWith('/tmp/') || !dist.startsWith('/tmp/')) throw new Error('Profiling exports and builds must stay in /tmp')
const git = (args: string[]) => {
  const result = spawnSync('git', args, { cwd: repoRoot, maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.toString())
  return result.stdout
}
const sourceCommit = git(['rev-parse', `${ref}^{commit}`]).toString().trim()
// mkdir without recursive deliberately refuses to reuse an edited export.
mkdirSync(sourceRoot)
const archive = git(['archive', sourceCommit])
const unpack = spawnSync('tar', ['-x', '-C', sourceRoot], { input: archive })
if (unpack.status !== 0) throw new Error(unpack.stderr.toString())
symlinkSync(path.join(repoRoot, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'dir')
const sourceClient = path.join(sourceRoot, 'client')
symlinkSync(path.join(repoRoot, 'client/node_modules'), path.join(sourceClient, 'node_modules'), 'dir')
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(sourceClient, 'vite.config.ts'))
if (!loaded) throw new Error('Unable to load source Vite config')
const require = createRequire(path.join(repoRoot, 'client/package.json'))
await build({
  ...loaded.config,
  configFile: false,
  root: sourceClient,
  mode: 'production',
  resolve: {
    ...loaded.config.resolve,
    alias: [
      { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/profiling') },
      { find: '@', replacement: path.join(sourceClient, 'src') },
    ],
  },
  plugins: [...(loaded.config.plugins ?? []), createProfilingOverlay(path.join(sourceClient, 'src/main.tsx'))],
  build: { ...loaded.config.build, outDir: dist, emptyOutDir: true },
})
const overlayFile = path.join(repoRoot, 'client/tests/performance/profiling-overlay.ts')
const files: string[] = []
const collect = (directory: string) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(file)
    else files.push(file)
  }
}
collect(dist)
const distHash = createHash('sha256')
for (const file of files.sort()) {
  distHash.update(`${path.relative(dist, file)}\0`)
  distHash.update(readFileSync(file))
}
const hashFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
writeFileSync(`${dist}.build.json`, `${JSON.stringify({
  sourceCommit,
  sourceFilesDirty: false,
  sourceArchiveSha256: createHash('sha256').update(archive).digest('hex'),
  sourceLockSha256: hashFile(path.join(sourceRoot, 'pnpm-lock.yaml')),
  installedWorkspaceLockSha256: hashFile(path.join(repoRoot, 'pnpm-lock.yaml')),
  distSha256: distHash.digest('hex'),
  buildMode: 'production-with-react-profiling',
  profilingBoundary: 'StrictMode > Profiler(id=App) > App',
  reactDomAlias: 'exact react-dom/client -> react-dom/profiling',
  overlaySha256: hashFile(overlayFile),
  nodeVersion: process.version,
  reactVersion: require('react/package.json').version,
  reactDomVersion: require('react-dom/package.json').version,
  viteVersion: require('vite/package.json').version,
}, null, 2)}\n`)
