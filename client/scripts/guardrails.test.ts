import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  analyzeDependencies,
  analyzeSize,
  buildImportEdges,
  checkPageGuardrails,
  collectImportSpecifiers,
  countLines,
  evaluateSizeBudget,
  findDomainCycles,
  isSizeBaseline,
  readSourceTree,
  resolveImport,
  sizeCategoryOf,
  type SizeBaseline,
  type SourceFile,
} from './guardrails.ts'

const files = (...entries: [path: string, source?: string][]): SourceFile[] =>
  entries.map(([path, source = '']) => ({ path, source }))

describe('import extraction and resolution', () => {
  it('collects static, re-export and dynamic imports but ignores comments and strings', () => {
    const source = `
      import { a } from '@/features/a'
      export { b } from './b'
      import './styles.css'
      // import { ignored } from '@/features/ignored'
      const text = "import x from '@/features/not-an-import'"
      const load = () => import('@/features/lazy')
    `

    expect(collectImportSpecifiers(source, 'features/demo/model/x.ts')).toEqual([
      '@/features/a',
      './b',
      './styles.css',
      '@/features/lazy',
    ])
  })

  it('resolves aliases, relative paths and directory indexes against known sources', () => {
    const known = new Set([
      'features/a/index.ts',
      'features/a/model/x.ts',
      'features/b/index.ts',
      'pages/b/Page.tsx',
      'shared/api/index.ts',
    ])

    expect(resolveImport('@/features/b', 'features/a/index.ts', known)).toBe('features/b/index.ts')
    expect(resolveImport('@/features/a/model/x', 'features/b/index.ts', known)).toBe('features/a/model/x.ts')
    expect(resolveImport('../../pages/b/Page', 'features/b/index.ts', known)).toBe('pages/b/Page.tsx')
    expect(resolveImport('@/shared/api', 'features/a/index.ts', known)).toBe('shared/api/index.ts')
    expect(resolveImport('react', 'features/a/index.ts', known)).toBeNull()
    expect(resolveImport('./missing', 'features/a/index.ts', known)).toBeNull()
  })

  it('builds edges only for source-to-source imports', () => {
    const edges = buildImportEdges(files(
      ['features/a/index.ts', "import { b } from '@/features/b'\nimport './styles/a.css'\n"],
      ['features/b/index.ts', 'export const b = 1\n'],
    ))

    expect(edges).toEqual([{ from: 'features/a/index.ts', to: 'features/b/index.ts', specifier: '@/features/b' }])
  })
})

describe('dependency guardrails', () => {
  it('flags a feature importing another feature by a deep alias path', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "import { b } from '@/features/b/model/b'\n"],
      ['features/b/index.ts', 'export const b = 1\n'],
      ['features/b/model/b.ts', 'export const b = 1\n'],
    ))

    expect(analysis.violations.some(violation =>
      violation.rule === 'deep-import'
      && violation.file === 'features/a/index.ts'
      && violation.message.includes('@/features/b'),
    )).toBe(true)
  })

  it('flags explicit index paths and trailing slashes as public-surface bypass', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "export { b } from '@/features/b/index'\nexport { b as c } from '@/features/b/'\n"],
      ['features/b/index.ts', 'export const b = 1\n'],
    ))

    expect(analysis.violations.map(violation => violation.rule)).toEqual(['deep-import', 'deep-import'])
  })

  it('flags a cross-domain relative import even when it lands on the public index', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "export { b } from '../b'\n"],
      ['features/b/index.ts', 'export const b = 1\n'],
    ))

    expect(analysis.violations).toEqual([
      expect.objectContaining({
        rule: 'deep-import',
        file: 'features/a/index.ts',
      }),
    ])
  })

  it('flags app deep imports, shared reverse dependencies and feature-to-app imports', () => {
    const analysis = analyzeDependencies(files(
      ['app/router/pages.ts', "import Workspace from '../../features/a/components/Workspace'\nimport Page from '@/pages/a/Page'\n"],
      ['features/a/index.ts', 'export { default as Workspace } from "./components/Workspace"\n'],
      ['features/a/components/Workspace.tsx', 'export default function Workspace() { return null }\n'],
      ['pages/a/Page.tsx', 'export default function Page() { return null }\n'],
      ['shared/utils/leak.ts', "import { a } from '@/features/a'\n"],
      ['features/a/model/reverse.ts', "import App from '@/app/App'\n"],
      ['app/App.tsx', 'export default function App() { return null }\n'],
    ))

    expect(analysis.violations.map(violation => violation.rule)).toEqual([
      'deep-import',
      'layer-direction',
      'layer-direction',
    ])
  })

  it('flags feature and task-execution imports of the root entry', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "import { boot } from '@/main'\nexport const a = boot\n"],
      ['features/task-execution/index.ts', "import { boot } from '@/main'\nexport const t = boot\n"],
      ['main.tsx', 'export const boot = 1\n'],
    ))

    expect(analysis.violations).toEqual([
      expect.objectContaining({ rule: 'layer-direction', file: 'features/a/index.ts' }),
      expect.objectContaining({ rule: 'layer-direction', file: 'features/task-execution/index.ts' }),
    ])
  })

  it('keeps task-execution free of reverse dependencies on page domains', () => {
    const analysis = analyzeDependencies(files(
      ['features/task-execution/index.ts', "import { useStatusStore } from '@/features/runtime-status'\n"],
      ['features/runtime-status/index.ts', 'export const useStatusStore = () => null\n'],
    ))

    expect(analysis.violations).toEqual([
      expect.objectContaining({
        rule: 'task-execution-reverse',
        file: 'features/task-execution/index.ts',
      }),
    ])
  })

  it('allows cross-domain public imports, same-domain relative imports and shared imports', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "import { b } from '@/features/b'\nimport { api } from '@/shared/api'\nexport { b, api }\n"],
      ['features/a/components/Workspace.tsx', "import { helper } from '../model/helper'\nimport { b } from '@/features/b'\nexport const value = helper(b)\n"],
      ['features/a/model/helper.ts', 'export const helper = (value: unknown) => value\n'],
      ['features/b/index.ts', 'export const b = 1\n'],
      ['shared/api/index.ts', 'export const api = 1\n'],
    ))

    expect(analysis.violations).toEqual([])
    expect(analysis.cycles).toEqual([])
  })

  it('flags a real two-domain dependency cycle with a readable path', () => {
    const analysis = analyzeDependencies(files(
      ['features/a/index.ts', "import { b } from '@/features/b'\nexport const a = b\n"],
      ['features/b/index.ts', "import { a } from '@/features/a'\nexport const b = a\n"],
    ))

    expect(analysis.cycles).toEqual([['a', 'b', 'a']])
    expect(analysis.violations).toEqual([
      expect.objectContaining({ rule: 'domain-cycle' }),
    ])
    expect(analysis.violations[0]?.message).toContain('a → b → a')
  })

  it('flags the former training ↔ statistics shape as a real domain cycle', () => {
    const analysis = analyzeDependencies(files(
      ['features/training/index.ts', "import { drops } from '@/features/statistics'\nexport const training = drops\n"],
      ['features/statistics/index.ts', "import { queue } from '@/features/training'\nexport const statistics = queue\n"],
    ))

    expect(analysis.cycles).toEqual([['statistics', 'training', 'statistics']])
  })

  it('ignores test-only imports when building the runtime graph', () => {
    const analysis = analyzeDependencies(files(
      ['pages/a/Page.test.tsx', "import { internals } from '../b/model/internals'\ninternals()\n"],
      ['pages/a/Page.tsx', 'export default function Page() { return null }\n'],
      ['features/b/index.ts', 'export const b = 1\n'],
      ['features/b/model/internals.ts', 'export const internals = () => 1\n'],
    ))

    expect(analysis.violations).toEqual([])
  })

  it('reports no cycle for a one-directional cross-domain dependency', () => {
    const edges = buildImportEdges(files(
      ['features/a/index.ts', "import { b } from '@/features/b'\n"],
      ['features/b/index.ts', 'export const b = 1\n'],
      ['features/c/index.ts', "import { b } from '@/features/b'\n"],
    ))

    expect(findDomainCycles(edges)).toEqual([])
  })
})

describe('page responsibility guardrails', () => {
  it('flags a page that imports transport or Query infrastructure directly', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "import { fetchWithAuth } from '@/shared/api'",
        "import { getQueryClient } from '@/shared/query'",
        "import { useQuery } from '@tanstack/react-query'",
        'export default function Page() { return null }',
      ].join('\n')],
      ['shared/api/index.ts', 'export const fetchWithAuth = () => null\n'],
      ['shared/query/index.ts', 'export const getQueryClient = () => null\n'],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-transport',
      'page-transport',
    ])
  })

  it('flags bare transport, storage and polling globals in a page', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'export default function Page() {',
        "  fetch('/api/agent/tasks/status')",
        "  new WebSocket('/webrtc-signaling/socket')",
        "  window.localStorage.getItem('draft')",
        '  setInterval(() => fetch(\'/api/agent/tasks/status\'), 1000)',
        '  return null',
        '}',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-transport',
      'page-storage',
      'page-polling',
      'page-transport',
    ])
  })

  it('flags a page importing a domain endpoint through the feature public surface', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', [
        "export { executeScheduleNow } from './api'",
        "export { useAutomationThing } from './hooks/useAutomationThing'",
      ].join('\n')],
      ['features/automation/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/automation/hooks/useAutomationThing.ts', 'export const useAutomationThing = () => null\n'],
      ['pages/a/Page.tsx', [
        "import { executeScheduleNow, useAutomationThing } from '@/features/automation'",
        'export default function Page() {',
        '  useAutomationThing()',
        '  executeScheduleNow()',
        '  return null',
        '}',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  it('flags a page namespace-importing a domain that re-exports endpoints', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', "export { executeScheduleNow } from './api'\n"],
      ['features/automation/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['pages/a/Page.tsx', [
        "import * as automation from '@/features/automation'",
        'export default function Page() { automation.executeScheduleNow(); return null }',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  it('flags own feature index endpoints imported relatively, as namespace, or dynamically', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', [
        "export { executeScheduleNow } from './api'",
        "export { useAutomationThing } from './hooks/useAutomationThing'",
      ].join('\n')],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/a/hooks/useAutomationThing.ts', 'export const useAutomationThing = () => null\n'],
      ['pages/a/Page.tsx', [
        "import { executeScheduleNow } from '@/features/a'",
        "import * as automation from '@/features/a'",
        "const load = async () => { const m = await import('@/features/a'); m.executeScheduleNow() }",
        'export default function Page() {',
        '  executeScheduleNow()',
        '  automation.executeScheduleNow()',
        '  load()',
        '  return null',
        '}',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(3)
    expect(violations.every(violation => violation.rule === 'page-transport')).toBe(true)
    expect(violations.map(violation => violation.message).join('\n')).toContain('executeScheduleNow')
  })

  const localReExportCases = [
    ['named import and export', [
      "import { executeScheduleNow } from './api'",
      'export { executeScheduleNow }',
    ].join('\n'), [
      "import { executeScheduleNow } from '@/features/a'",
      'executeScheduleNow()',
    ].join('\n')],
    ['aliased import and export', [
      "import { executeScheduleNow as run } from './api'",
      'export { run as executeScheduleNow }',
    ].join('\n'), [
      "import { executeScheduleNow } from '@/features/a'",
      'executeScheduleNow()',
    ].join('\n')],
    ['namespace page usage', [
      "import { executeScheduleNow } from './api'",
      'export { executeScheduleNow }',
    ].join('\n'), [
      "import * as automation from '@/features/a'",
      'automation.executeScheduleNow()',
    ].join('\n')],
    ['dynamic page usage', [
      "import { executeScheduleNow } from './api'",
      'export { executeScheduleNow }',
    ].join('\n'), [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  m.executeScheduleNow()',
      '}',
    ].join('\n')],
    ['then page usage', [
      "import { executeScheduleNow } from './api'",
      'export { executeScheduleNow }',
    ].join('\n'), [
      "const load = () => import('@/features/a').then(m => m.executeScheduleNow())",
    ].join('\n')],
  ] as const

  it.each(localReExportCases)('flags endpoints forwarded through local index %s', (_label, indexSource, pageSource) => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', indexSource],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['pages/a/Page.tsx', pageSource],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  const defaultOrNamespaceReExportCases = [
    ['default import and named export', [
      "import run from './api'",
      'export { run }',
    ].join('\n'), [
      "import { run } from '@/features/a'",
      'run()',
    ].join('\n'), 'run'],
    ['default import and default export', [
      "import run from './api'",
      'export default run',
    ].join('\n'), [
      "import run from '@/features/a'",
      'run()',
    ].join('\n'), 'default'],
    ['namespace import and named export', [
      "import * as api from './api'",
      'export { api }',
    ].join('\n'), [
      "import { api } from '@/features/a'",
      'api.executeScheduleNow()',
    ].join('\n'), 'api'],
    ['direct namespace re-export', [
      "export * as api from './api'",
    ].join('\n'), [
      "import { api } from '@/features/a'",
      'api.executeScheduleNow()',
    ].join('\n'), 'api'],
    ['namespace import and namespace page usage', [
      "import * as api from './api'",
      'export { api }',
    ].join('\n'), [
      "import * as domain from '@/features/a'",
      'domain.api.executeScheduleNow()',
    ].join('\n'), 'api'],
    ['namespace import and dynamic page usage', [
      "import * as api from './api'",
      'export { api }',
    ].join('\n'), [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  m.api.executeScheduleNow()',
      '}',
    ].join('\n'), 'api'],
  ] as const

  it.each(defaultOrNamespaceReExportCases)(
    'flags endpoints forwarded through %s',
    (_label, indexSource, pageSource, expectedName) => {
      const violations = checkPageGuardrails(files(
        ['features/a/index.ts', indexSource],
        ['features/a/api/index.ts', [
          'export const executeScheduleNow = () => null',
          'export default function run() { return null }',
        ].join('\n')],
        ['pages/a/Page.tsx', pageSource],
      ))

      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({ rule: 'page-transport' })
      expect(violations[0]?.message).toContain(expectedName)
    },
  )

  it('flags a default export of an endpoint imported from api', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', [
        "import { executeScheduleNow } from './api'",
        'export default executeScheduleNow',
      ].join('\n')],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['pages/a/Page.tsx', [
        "import run from '@/features/a'",
        'run()',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('default')
  })

  const endpointUsageCases = [
    ['namespace receiver wrapped in as', [
      "import * as a from '@/features/a'",
      ';(a as any).executeScheduleNow()',
    ].join('\n')],
    ['namespace receiver wrapped in parentheses', [
      "import * as a from '@/features/a'",
      ';((a)).executeScheduleNow()',
    ].join('\n')],
    ['namespace receiver with non-null assertion', [
      "import * as a from '@/features/a'",
      ';(a!).executeScheduleNow()',
    ].join('\n')],
    ['namespace receiver wrapped in satisfies', [
      "import * as a from '@/features/a'",
      ';(a satisfies any).executeScheduleNow()',
    ].join('\n')],
    ['namespace alias', [
      "import * as a from '@/features/a'",
      'const b = a',
      'b.executeScheduleNow()',
    ].join('\n')],
    ['namespace parameter default destructuring', [
      "import * as a from '@/features/a'",
      'function f({ executeScheduleNow } = a) { return executeScheduleNow }',
    ].join('\n')],
    ['namespace assignment destructuring', [
      "import * as a from '@/features/a'",
      'let run',
      ';({ executeScheduleNow: run } = a)',
      'run()',
    ].join('\n')],
    ['dynamic import receiver wrapped in as', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  ;(m as any).executeScheduleNow()',
      '}',
    ].join('\n')],
    ['dynamic import receiver wrapped in parentheses', [
      'const load = async () => {',
      "  ;((await import('@/features/a'))).executeScheduleNow()",
      '}',
    ].join('\n')],
    ['dynamic import receiver with non-null assertion', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  m!.executeScheduleNow()',
      '}',
    ].join('\n')],
    ['dynamic import alias', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  const b = m',
      '  b.executeScheduleNow()',
      '}',
    ].join('\n')],
    ['dynamic import then callback wrapped in as', [
      "const load = () => import('@/features/a').then(m => (m as any).executeScheduleNow())",
    ].join('\n')],
    ['dynamic import assignment destructuring', [
      'const load = async () => {',
      '  let run',
      "  ;({ executeScheduleNow: run } = await import('@/features/a'))",
      '  run()',
      '}',
    ].join('\n')],
  ] as const

  it.each(endpointUsageCases)('flags endpoint usage through %s', (_label, source) => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', [
        "export { executeScheduleNow } from './api'",
        "export { useAutomationThing } from './hooks/useAutomationThing'",
      ].join('\n')],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/a/hooks/useAutomationThing.ts', 'export const useAutomationThing = () => null\n'],
      ['pages/a/Page.tsx', source],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  const aliasedEndpointCases = [
    ['namespace cast', [
      "import * as a from '@/features/a'",
      ';(a as any).executeScheduleNow()',
    ].join('\n')],
    ['relative public surface', [
      "import * as a from '../../features/a'",
      ';(a as any).executeScheduleNow()',
    ].join('\n')],
    ['namespace local alias', [
      "import * as a from '@/features/a'",
      'const b = a',
      'b.executeScheduleNow()',
    ].join('\n')],
    ['namespace parameter default destructuring', [
      "import * as a from '@/features/a'",
      'function f({ executeScheduleNow } = a) { return executeScheduleNow }',
    ].join('\n')],
    ['dynamic import cast', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  ;(m as any).executeScheduleNow()',
      '}',
    ].join('\n')],
    ['dynamic import local alias', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      '  const b = m',
      '  b.executeScheduleNow()',
      '}',
    ].join('\n')],
    ['dynamic import then callback cast', [
      "const load = () => import('@/features/a').then(m => (m as any).executeScheduleNow())",
    ].join('\n')],
    ['dynamic import wrapped then callback', [
      "const load = () => import('@/features/a').then(((m) => m.executeScheduleNow()))",
    ].join('\n')],
    ['computed destructuring key', [
      'const load = async () => {',
      "  const m = await import('@/features/a')",
      "  const { ['executeScheduleNow']: run } = m",
      '  run()',
      '}',
    ].join('\n')],
  ] as const

  it.each(aliasedEndpointCases)('flags endpoint usage through %s', (_label, source) => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', "export { executeScheduleNow } from './api'\n"],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['pages/a/Page.tsx', source],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  it('allows own feature index hooks imported as namespace or dynamic', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', [
        "export { executeScheduleNow } from './api'",
        "import { useAutomationThing } from './hooks/useAutomationThing'",
        'export { useAutomationThing }',
      ].join('\n')],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/a/hooks/useAutomationThing.ts', 'export const useAutomationThing = () => null\n'],
      ['pages/a/Page.tsx', [
        "import * as automation from '@/features/a'",
        'const helper = automation',
        'const load = async () => {',
        "  const m = await import('@/features/a')",
        '  const copy = m',
        '  return copy.useAutomationThing()',
        '}',
        'export default function Page() { helper.useAutomationThing(); load(); return null }',
      ].join('\n')],
    ))

    expect(violations).toEqual([])
  })

  it('does not flag dynamic imports used only for domain hooks', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', [
        "export { executeScheduleNow } from './api'",
        "export { useAutomationThing } from './hooks/useAutomationThing'",
      ].join('\n')],
      ['features/automation/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/automation/hooks/useAutomationThing.ts', 'export const useAutomationThing = () => null\n'],
      ['pages/a/Page.tsx', [
        'export default async function Page() {',
        "  const m = await import('@/features/automation')",
        '  m.useAutomationThing()',
        '  return null',
        '}',
      ].join('\n')],
    ))

    expect(violations).toEqual([])
  })

  it('does not treat the API default export as forwarded by export *', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', [
        "export * from './api'",
        "export { default as AutomationWorkspace } from './components/AutomationWorkspace'",
      ].join('\n')],
      ['features/automation/api/index.ts', 'export default () => null\n'],
      ['features/automation/components/AutomationWorkspace.tsx', 'export default function Workspace() { return null }\n'],
      ['pages/automation/AutomationTasks.tsx', 'export default function Page() { return null }\n'],
      ['pages/a/Page.tsx', [
        "import { AutomationWorkspace } from '@/features/automation'",
        'export default function Wrapper() { return <AutomationWorkspace /> }',
      ].join('\n')],
    ))

    expect(violations).toEqual([])
  })

  it('expands export * from api when locating public endpoints', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', "export * from './api'\n"],
      ['features/automation/api/index.ts', [
        'export const executeScheduleNow = () => null',
        'export function getActivity() { return null }',
      ].join('\n')],
      ['pages/a/Page.tsx', [
        "import { executeScheduleNow } from '@/features/automation'",
        'export default function Page() { executeScheduleNow(); return null }',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('executeScheduleNow')
  })

  it('flags a page dynamically importing a domain that exposes endpoints', () => {
    const violations = checkPageGuardrails(files(
      ['features/automation/index.ts', "export { executeScheduleNow } from './api'\n"],
      ['features/automation/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['pages/a/Page.tsx', [
        "const load = () => import('@/features/automation').then(m => m.executeScheduleNow())",
        'export default function Page() { load(); return null }',
      ].join('\n')],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('动态 import')
  })

  it('flags a page importing its own domain api directly', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "import { loadThing } from '@/features/a/api'",
        'export default function Page() { loadThing(); return null }',
      ].join('\n')],
      ['features/a/api/index.ts', 'export const loadThing = () => null\n'],
    ))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'page-transport' })
    expect(violations[0]?.message).toContain('本域 API')
  })

  it('does not flag type-only imports from transport or query modules', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "import type { ApiResponse } from '@/shared/api'",
        "import type { QueryClient } from '@tanstack/react-query'",
        "import { type AutomationActivityPayload } from '@/features/automation'",
        'export type { ApiResponse, QueryClient, AutomationActivityPayload }',
        'export default function Page() { return null }',
      ].join('\n')],
      ['shared/api/index.ts', 'export type ApiResponse = { ok: boolean }\n'],
      ['features/automation/index.ts', 'export type { AutomationActivityPayload } from "./types"\n'],
    ))

    expect(violations).toEqual([])
  })

  it('detects computed global access and ignores local binding names', () => {
    const computed = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "window['fetch']('/api/agent/tasks/status')",
        "globalThis['setInterval'](() => {}, 1000)",
        "window[`localStorage`].getItem('draft')",
        'export default function Page() { return null }',
      ].join('\n')],
    ))
    expect(computed.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-polling',
      'page-storage',
    ])

    const shadowed = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'const { fetch, localStorage: storage } = useProps()',
        'function setInterval() {}',
        'type fetch = () => void',
        'interface localStorage {}',
        'enum setInterval { A }',
        'function generic<fetch>() { return null }',
        'type Props = { fetch: string; localStorage: string }',
        'export default function Page() { return null }',
      ].join('\n')],
    ))
    expect(shadowed).toEqual([])
  })

  it('flags destructuring transport, storage and polling from global objects', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'const { fetch: f } = window',
        'const { localStorage: s } = globalThis',
        'const { setInterval: i } = (self as any)',
        "f('/api/agent/tasks/status')",
        "s.getItem('draft')",
        'i(() => {}, 1000)',
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-storage',
      'page-polling',
    ])
  })

  it('flags assignment destructuring, property chains and wrapped indexes of global objects', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'let f',
        '({ fetch: f } = window)',
        "f('/api/agent/tasks/status')",
        'const { fetch: g } = window.window',
        "g('/api/agent/tasks/status')",
        "window[('fetch')]('/api/agent/tasks/status')",
        'const { localStorage: s } = globalThis.window',
        "s.getItem('draft')",
        "window[('setInterval')](() => {}, 1000)",
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-transport',
      'page-transport',
      'page-storage',
      'page-polling',
    ])
  })

  const globalBypassCases = [
    ['assignment destructuring from window', [
      'let f',
      '({ fetch: f } = window)',
      "f('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['nested assignment destructuring', [
      'let f',
      '({ a: { fetch: f } } = window)',
      "f('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['destructuring from window.window', [
      'const { fetch: f } = window.window',
      "f('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['destructured parameter default', [
      'function f({ fetch: g } = window) { return g }',
    ].join('\n'), 'page-transport'],
    ['parenthesized string index', [
      "window[('fetch')]('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['computed binding key', [
      "const { ['fetch']: f } = window",
      "f('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['computed assignment key', [
      'let f',
      "({ ['fetch']: f } = window)",
      "f('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['window.document.defaultView chain', [
      "window.document.defaultView.fetch('/api/agent/tasks/status')",
    ].join('\n'), 'page-transport'],
    ['globalThis document defaultView chain', [
      "globalThis['document'].defaultView.localStorage.getItem('draft')",
    ].join('\n'), 'page-storage'],
  ] as const

  it.each(globalBypassCases)('flags a global primitive bypass through %s', (_label, source, rule) => {
    const violations = checkPageGuardrails(files(['pages/a/Page.tsx', source]))

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule })
  })

  it('does not flag nested assignment targets that do not come from a global object', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'const props = { a: { fetch: null } }',
        'let local',
        ';({ a: { fetch: local } } = props)',
        ';({ a: { fetch } } = props)',
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations).toEqual([])
  })

  it('flags window proxies and document.defaultView as global objects', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "window.top.fetch('/api/agent/tasks/status')",
        "window.parent['localStorage'].getItem('draft')",
        'document.defaultView!.setInterval(() => {}, 1000)',
        'document["defaultView"]?.fetch("/api/agent/tasks/status")',
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-storage',
      'page-polling',
      'page-transport',
    ])
  })

  it('does not flag module-level helpers named like transport primitives', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/index.ts', "export { fetch } from './model/http'\n"],
      ['features/a/model/http.ts', 'export const fetch = () => null\n'],
      ['pages/a/Page.tsx', [
        "import { fetch } from '@/features/a'",
        'function localStorage() { return null }',
        'const payload = { fetch, localStorage }',
        'fetch(); localStorage()',
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations).toEqual([])
  })

  it('ignores global names in type positions without hiding runtime usage', () => {
    const typesOnly = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'type Fetcher = typeof fetch',
        'type Storage = typeof localStorage',
        'type Timer = ReturnType<typeof setInterval>',
        'type FetchReference = fetch',
        'type WindowFetch = typeof window.fetch',
        "import type { fetch as TransportHelper } from '@/shared/api'",
        'type ImportedHelper = typeof TransportHelper',
        'export type { Fetcher, Storage, Timer, FetchReference, WindowFetch, ImportedHelper }',
      ].join('\n')],
    ))
    expect(typesOnly).toEqual([])

    const runtime = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'type Fetcher = typeof fetch',
        "fetch('/api/agent/tasks/status')",
        "window.localStorage.getItem('draft')",
      ].join('\n')],
    ))
    expect(runtime.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-storage',
    ])
  })

  it('still flags global primitives captured through shorthand object literals', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        'const payload = { fetch }',
        'const storage = window.localStorage',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-storage',
    ])
  })

  it('does not flag import/export aliases or non-global assignment destructuring', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "import { fetch as fetchJson } from '../model/http'",
        'export { fetchJson as fetch }',
        'const props = { fetch: null }',
        'let local',
        ';({ fetch: local } = props)',
        ';({ fetch } = props)',
        'export default function Page() { return null }',
      ].join('\n')],
      ['features/a/model/http.ts', 'export const fetch = () => null\n'],
    ))

    expect(violations).toEqual([])
  })

  it('detects wrapped global objects before property access', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.tsx', [
        "(window as any).fetch('/api/agent/tasks/status');",
        "window!.fetch('/api/agent/tasks/status');",
        "(window).localStorage.getItem('draft');",
        "(globalThis as any)['setInterval'](() => {}, 1000);",
        'export default function Page() { return null }',
      ].join('\n')],
    ))

    expect(violations.map(violation => violation.rule)).toEqual([
      'page-transport',
      'page-transport',
      'page-storage',
      'page-polling',
    ])
  })

  it('allows a page to call its domain container hook through the public surface', () => {
    const sourceFiles = files(
      ['features/a/index.ts', [
        "export { executeScheduleNow } from './api'",
        "export { useWorkspace } from './hooks/useWorkspace'",
      ].join('\n')],
      ['features/a/api/index.ts', 'export const executeScheduleNow = () => null\n'],
      ['features/a/hooks/useWorkspace.ts', 'export const useWorkspace = () => "ok"\n'],
      ['pages/a/Page.tsx', [
        "import { useWorkspace } from '@/features/a'",
        'export default function Page() {',
        '  const value = useWorkspace()',
        '  return <div>{value}</div>',
        '}',
      ].join('\n')],
    )

    expect(checkPageGuardrails(sourceFiles)).toEqual([])
    expect(analyzeDependencies(sourceFiles).violations).toEqual([])
  })

  it('allows domain containers and hooks to use fetch and timers', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/components/Workspace.tsx', [
        "import { fetchWithAuth } from '@/shared/api'",
        'export function Workspace() {',
        "  setInterval(() => fetchWithAuth('/api/agent/tasks/status'), 1000)",
        '  return null',
        '}',
      ].join('\n')],
      ['features/a/hooks/useWorkspace.ts', "export const useWorkspace = () => fetch('/api/agent/tasks/status')\n"],
      ['shared/api/index.ts', 'export const fetchWithAuth = () => null\n'],
    ))

    expect(violations).toEqual([])
  })

  it('does not apply page restrictions to page tests', () => {
    const violations = checkPageGuardrails(files(
      ['pages/a/Page.test.tsx', "fetch('/api/agent/tasks/status')\n"],
    ))

    expect(violations).toEqual([])
  })
})

describe('size reporting and budget', () => {
  const thresholds = { pages: 10, hooks: 10, model: 10, components: 10 }

  it('counts lines with and without a trailing newline', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\n')).toBe(2)
  })

  it('classifies feature source files and ignores tests', () => {
    expect(sizeCategoryOf('pages/a/Page.tsx')).toBe('pages')
    expect(sizeCategoryOf('features/a/hooks/useThing.ts')).toBe('hooks')
    expect(sizeCategoryOf('features/a/model/thing.ts')).toBe('model')
    expect(sizeCategoryOf('features/a/components/Thing.tsx')).toBe('components')
    expect(sizeCategoryOf('features/a/components/Thing.test.tsx')).toBeNull()
    expect(sizeCategoryOf('features/a/api/index.ts')).toBeNull()
  })

  it('reports per-category lines, medians and large files', () => {
    const report = analyzeSize(files(
      ['pages/a/Page.tsx', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n'],
      ['pages/a/Small.tsx', '1\n2\n'],
      ['features/a/hooks/useThing.ts', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n'],
      ['features/a/components/Thing.test.tsx', '1\n'.repeat(50)],
    ), thresholds)

    const pages = report.categories.find(category => category.category === 'pages')
    expect(pages).toMatchObject({ fileCount: 2, totalLines: 13, medianLines: 7 })
    expect(pages?.largeFiles.map(entry => entry.path)).toEqual(['pages/a/Page.tsx'])
    expect(report.totalFiles).toBe(3)
  })

  it('fails only for new over-threshold files and notes recovered baseline entries', () => {
    const report = analyzeSize(files(
      ['features/a/hooks/useLarge.ts', '1\n'.repeat(11)],
      ['features/a/hooks/useSmall.ts', '1\n'.repeat(2)],
      ['pages/a/Page.tsx', '1\n'.repeat(11)],
    ), thresholds)

    const baseline: SizeBaseline = {
      thresholds,
      largeFiles: {
        pages: ['pages/a/Page.tsx'],
        hooks: ['features/a/hooks/useRecovered.ts'],
        model: [],
        components: [],
      },
      pageLines: {},
      nonPageLines: {},
    }

    const result = evaluateSizeBudget(report, baseline)
    expect(result.violations).toEqual([
      expect.stringContaining('features/a/hooks/useLarge.ts'),
    ])
    expect(result.violations).toHaveLength(1)
    expect(result.notes).toEqual([
      expect.stringContaining('features/a/hooks/useRecovered.ts'),
    ])
  })

  it('flags page logic moved into same-domain hooks/model/components', () => {
    const relocationThresholds = { pages: 500, hooks: 500, model: 500, components: 500 }
    const report = analyzeSize(files(
      ['features/a/hooks/usePage.ts', '1\n'.repeat(70)],
      ['pages/b/Page.tsx', '1\n'.repeat(70)],
      ['features/b/hooks/usePage.ts', '1\n'.repeat(30)],
      ['pages/c/Page.tsx', '1\n'.repeat(30)],
      ['features/c/hooks/usePage.ts', '1\n'.repeat(20)],
    ), relocationThresholds)

    const baseline: SizeBaseline = {
      thresholds: relocationThresholds,
      largeFiles: { pages: [], hooks: [], model: [], components: [] },
      pageLines: { a: 70, b: 100, c: 100 },
      nonPageLines: { a: 0, b: 0, c: 0 },
    }

    const result = evaluateSizeBudget(report, baseline)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('pages/a')
    expect(result.violations[0]).toContain('疑似把页面逻辑搬进非页面目录')
  })

  it('skips relocation checks for legacy baselines without domain totals', () => {
    const relocationThresholds = { pages: 500, hooks: 500, model: 500, components: 500 }
    const report = analyzeSize(files(
      ['features/a/hooks/usePage.ts', '1\n'.repeat(70)],
    ), relocationThresholds)
    const baseline: SizeBaseline = {
      thresholds: relocationThresholds,
      largeFiles: { pages: [], hooks: [], model: [], components: [] },
    }

    expect(evaluateSizeBudget(report, baseline).violations).toEqual([])
  })

  it('accepts full and legacy size baselines but rejects invalid shapes', () => {
    const base = {
      thresholds: { pages: 60, hooks: 220, model: 340, components: 320 },
      largeFiles: { pages: [], hooks: [], model: [], components: [] },
    }

    expect(isSizeBaseline(base)).toBe(true)
    expect(isSizeBaseline({ ...base, pageLines: { a: 1 }, nonPageLines: { a: 2 } })).toBe(true)
    expect(isSizeBaseline({ ...base, thresholds: { ...base.thresholds, pages: 0 } })).toBe(false)
    expect(isSizeBaseline({ ...base, pageLines: { a: 'x' } })).toBe(false)
    expect(isSizeBaseline(null)).toBe(false)
  })
})

describe('current source tree', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
  const budgetPath = fileURLToPath(new URL('../size-budget.json', import.meta.url))

  it('has no dependency, public-surface or page responsibility violations', async () => {
    const sourceFiles = await readSourceTree(srcRoot)
    const dependencyAnalysis = analyzeDependencies(sourceFiles)

    expect(sourceFiles.length).toBeGreaterThan(0)
    expect(dependencyAnalysis.cycles).toEqual([])
    expect(dependencyAnalysis.violations).toEqual([])
    expect(checkPageGuardrails(sourceFiles)).toEqual([])
    expect(
      dependencyAnalysis.violations.filter(violation => violation.rule === 'task-execution-reverse'),
    ).toEqual([])
  })

  it('stays within the committed size budget', async () => {
    const sourceFiles = await readSourceTree(srcRoot)
    const baseline = JSON.parse(readFileSync(budgetPath, 'utf8')) as SizeBaseline
    const report = analyzeSize(sourceFiles, baseline.thresholds)

    expect(evaluateSizeBudget(report, baseline).violations).toEqual([])
  })
})
