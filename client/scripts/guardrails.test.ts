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
      'features/b/pages/Page.tsx',
      'shared/api/index.ts',
    ])

    expect(resolveImport('@/features/b', 'features/a/index.ts', known)).toBe('features/b/index.ts')
    expect(resolveImport('@/features/a/model/x', 'features/b/index.ts', known)).toBe('features/a/model/x.ts')
    expect(resolveImport('./pages/Page', 'features/b/index.ts', known)).toBe('features/b/pages/Page.tsx')
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
      ['app/router/pages.ts', "import Page from '../../features/a/pages/Page'\n"],
      ['features/a/index.ts', 'export { default } from "./pages/Page"\n'],
      ['features/a/pages/Page.tsx', 'export default function Page() { return null }\n'],
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
      ['features/a/pages/Page.test.tsx', "import { internals } from '../b/model/internals'\ninternals()\n"],
      ['features/a/pages/Page.tsx', 'export default function Page() { return null }\n'],
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
      ['features/a/pages/Page.tsx', [
        "import { fetchWithAuth } from '@/shared/api'",
        "import { useQuery } from '@tanstack/react-query'",
        'export default function Page() { return null }',
      ].join('\n')],
      ['shared/api/index.ts', 'export const fetchWithAuth = () => null\n'],
    ))

    expect(violations.map(violation => violation.rule)).toEqual(['page-transport', 'page-transport'])
  })

  it('flags bare transport, storage and polling globals in a page', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/pages/Page.tsx', [
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

  it('allows a page to call its domain container hook', () => {
    const violations = checkPageGuardrails(files(
      ['features/a/pages/Page.tsx', [
        "import { useWorkspace } from '../hooks/useWorkspace'",
        'export default function Page() {',
        '  const value = useWorkspace()',
        '  return <div>{value}</div>',
        '}',
      ].join('\n')],
      ['features/a/hooks/useWorkspace.ts', 'export const useWorkspace = () => "ok"\n'],
    ))

    expect(violations).toEqual([])
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
      ['features/a/pages/Page.test.tsx', "fetch('/api/agent/tasks/status')\n"],
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
    expect(sizeCategoryOf('features/a/pages/Page.tsx')).toBe('pages')
    expect(sizeCategoryOf('features/a/hooks/useThing.ts')).toBe('hooks')
    expect(sizeCategoryOf('features/a/model/thing.ts')).toBe('model')
    expect(sizeCategoryOf('features/a/components/Thing.tsx')).toBe('components')
    expect(sizeCategoryOf('features/a/components/Thing.test.tsx')).toBeNull()
    expect(sizeCategoryOf('features/a/api/index.ts')).toBeNull()
  })

  it('reports per-category lines, medians and large files', () => {
    const report = analyzeSize(files(
      ['features/a/pages/Page.tsx', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n'],
      ['features/a/pages/Small.tsx', '1\n2\n'],
      ['features/a/hooks/useThing.ts', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n'],
      ['features/a/components/Thing.test.tsx', '1\n'.repeat(50)],
    ), thresholds)

    const pages = report.categories.find(category => category.category === 'pages')
    expect(pages).toMatchObject({ fileCount: 2, totalLines: 13, medianLines: 7 })
    expect(pages?.largeFiles.map(entry => entry.path)).toEqual(['features/a/pages/Page.tsx'])
    expect(report.totalFiles).toBe(3)
  })

  it('fails only for new over-threshold files and notes recovered baseline entries', () => {
    const report = analyzeSize(files(
      ['features/a/hooks/useLarge.ts', '1\n'.repeat(11)],
      ['features/a/hooks/useSmall.ts', '1\n'.repeat(2)],
      ['features/a/pages/Page.tsx', '1\n'.repeat(11)],
    ), thresholds)

    const baseline: SizeBaseline = {
      thresholds,
      largeFiles: {
        pages: ['features/a/pages/Page.tsx'],
        hooks: ['features/a/hooks/useRecovered.ts'],
        model: [],
        components: [],
      },
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
