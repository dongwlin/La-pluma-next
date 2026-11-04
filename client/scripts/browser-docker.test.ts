import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }))

vi.mock('node:child_process', () => ({ spawnSync }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((file) => String(file).endsWith('package.json')
      ? JSON.stringify({ version: '1.64.1' })
      : 'fixture'),
    readdirSync: vi.fn((directory) => String(directory).endsWith('.pnpm')
      ? ['playwright@1.64.1']
      : []),
  }
})

const originalArgv = process.argv

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('VISUAL_SKIP_BUILD', '1')
  vi.stubEnv('INTEGRATION_SKIP_BUILD', '1')
  vi.stubEnv('PERFORMANCE_SKIP_BUILD', '1')
  vi.stubEnv('PERFORMANCE_DIST', undefined)
  vi.stubEnv('PERFORMANCE_BUILD_METADATA', undefined)
  vi.stubEnv('PERFORMANCE_OUTPUT', undefined)
  vi.stubEnv('PLAYWRIGHT_IMAGE', undefined)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw Object.assign(new Error(`Script exited with ${code}`), { code: Number(code) })
  })
})

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Docker browser test launchers', () => {
  it.each([
    ['../../scripts/visual-docker.mjs', 'client/tests/visual/playwright.config.ts'],
    ['./integration-docker.ts', 'client/tests/integration/playwright.config.ts'],
    ['./performance-docker.ts', 'client/tests/performance/playwright.config.ts'],
  ] as const)('isolates %s from host ports and preserves test arguments and failure status', async (script, config) => {
    let dockerArgs: string[] = []
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'run') {
        dockerArgs = args
        return { status: 23 }
      }
      return { status: 0, stdout: 'version-or-image-id\n' }
    })
    process.argv = ['node', script, '--grep', 'cross-page']

    await expect(import(new URL(script, import.meta.url).href)).rejects.toMatchObject({ code: 23 })

    expect(dockerArgs).not.toContain('--network=host')
    expect(dockerArgs.some(arg => arg === '-p' || arg.startsWith('--publish'))).toBe(false)
    expect(dockerArgs).toContain('--ipc=host')
    expect(dockerArgs).toContain('mcr.microsoft.com/playwright:v1.64.1-noble')
    expect(dockerArgs.slice(-4)).toEqual(['--config', config, '--grep', 'cross-page'])
  })
})
