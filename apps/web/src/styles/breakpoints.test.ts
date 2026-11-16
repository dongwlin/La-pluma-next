import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BREAKPOINTS } from '../shared/lib/breakpoints'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BREAKPOINT_KEYS = new Set(Object.keys(BREAKPOINTS))
const APPROVED_THRESHOLDS = new Set<number>(Object.values(BREAKPOINTS))

const CSS_EXTENSIONS = new Set(['.css'])
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage'])
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx']

const MEDIA_AT_RULE_RE = /@media\s+([^{]+)\{/g
const LEGACY_WIDTH_FEATURE_RE = /\b(?:min|max)-width\s*:/
const WIDTH_FEATURE_RE = /\bwidth\b/
const PX_VALUE_RE = /(\d+(?:\.\d+)?)px/g
const PAREN_GROUP_RE = /\(([^()]*)\)/g
const INTERPOLATION_RE = /\$\{([^}]*)\}/g
const BREAKPOINT_INTERPOLATION_RE = /^BREAKPOINTS\.([A-Za-z_$][\w$]*)$/
const SINGLE_COMPARISON_RE = /^width\s*(?:<|>=)\s*\d+(?:\.\d+)?px$/
const INTERVAL_COMPARISON_RE = /^\d+(?:\.\d+)?px\s*<=\s*width\s*<\s*\d+(?:\.\d+)?px$/
const ARBITRARY_BREAKPOINT_RE = /\b(?:min|max)-\[[^\]]*\]/g
const MATCH_MEDIA_LITERAL_RE = /matchMedia\??\.?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*\)/g
const MATCH_MEDIA_IDENTIFIER_RE = /matchMedia\??\.?\(\s*([A-Za-z_$][\w$]*)\s*\)/g
const STRING_CONSTANT_RE = /(?:^|\n)\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3/g

type MediaQueryProblem =
  | 'legacy-width'
  | 'direction'
  | 'unapproved-threshold'
  | 'non-breakpoint-interpolation'

interface MatchMediaCall {
  file: string
  expression: string
  query: string | null
}

function collectFiles(dir: string, extensions: Set<string>): string[] {
  return readdirSync(dir).flatMap(entry => {
    if (IGNORED_DIRECTORIES.has(entry)) return []
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectFiles(path, extensions)
    return extensions.has(extname(path)) ? [path] : []
  })
}

function isTestFile(file: string): boolean {
  return TEST_FILE_SUFFIXES.some(suffix => file.endsWith(suffix))
}

function location(file: string): string {
  return relative(SRC_ROOT, file)
}

function widthGroups(query: string): string[] {
  return [...query.matchAll(PAREN_GROUP_RE)].flatMap(match => {
    const group = match[1]?.trim()
    return group && WIDTH_FEATURE_RE.test(group) ? [group] : []
  })
}

function numericThresholds(query: string): number[] {
  return [...query.matchAll(PX_VALUE_RE)].map(match => Number(match[1]))
}

function auditMediaQuery(query: string): MediaQueryProblem[] {
  const problems = new Set<MediaQueryProblem>()
  if (LEGACY_WIDTH_FEATURE_RE.test(query)) problems.add('legacy-width')

  for (const match of query.matchAll(INTERPOLATION_RE)) {
    const expression = (match[1] ?? '').trim()
    const key = BREAKPOINT_INTERPOLATION_RE.exec(expression)?.[1]
    if (!key || !BREAKPOINT_KEYS.has(key)) problems.add('non-breakpoint-interpolation')
  }

  const staticQuery = query.replace(INTERPOLATION_RE, 'EXPR')
  const normalizedQuery = query.replace(INTERPOLATION_RE, '0')

  for (const group of widthGroups(normalizedQuery)) {
    if (!SINGLE_COMPARISON_RE.test(group) && !INTERVAL_COMPARISON_RE.test(group)) {
      problems.add('direction')
    }
  }
  for (const group of widthGroups(staticQuery)) {
    for (const threshold of numericThresholds(group)) {
      if (!APPROVED_THRESHOLDS.has(threshold)) problems.add('unapproved-threshold')
    }
  }

  return [...problems]
}

function collectMediaConditions(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(MEDIA_AT_RULE_RE)].flatMap(match => (
    match[1] ? [match[1].trim()] : []
  ))
}

function collectStringConstants(file: string) {
  const source = readFileSync(file, 'utf8')
  const local = new Map<string, string>()
  const exported = new Map<string, string>()

  for (const match of source.matchAll(STRING_CONSTANT_RE)) {
    const name = match[2]
    if (!name) continue
    const value = match[4] ?? ''
    local.set(name, value)
    if (match[1]) exported.set(name, value)
  }

  return { local, exported }
}

function collectMatchMediaCalls(file: string, exportedConstants: Map<string, string>): MatchMediaCall[] {
  const source = readFileSync(file, 'utf8')
  const { local } = collectStringConstants(file)
  const calls = new Map<string, MatchMediaCall>()

  for (const match of source.matchAll(MATCH_MEDIA_LITERAL_RE)) {
    const query = match[2]
    if (query === undefined) continue
    calls.set(`literal:${query}`, { file, expression: match[0], query })
  }
  for (const match of source.matchAll(MATCH_MEDIA_IDENTIFIER_RE)) {
    const name = match[1]
    if (!name || calls.has(`identifier:${name}`)) continue
    calls.set(`identifier:${name}`, {
      file,
      expression: match[0],
      query: local.get(name) ?? exportedConstants.get(name) ?? null,
    })
  }

  return [...calls.values()]
}

function collectProductionMatchMediaCalls(): MatchMediaCall[] {
  const files = collectFiles(SRC_ROOT, SCRIPT_EXTENSIONS).filter(file => !isTestFile(file))
  const exportedConstants = new Map<string, string>()

  for (const file of files) {
    for (const [name, value] of collectStringConstants(file).exported) {
      exportedConstants.set(name, value)
    }
  }

  return files.flatMap(file => collectMatchMediaCalls(file, exportedConstants))
}

describe('responsive breakpoint policy', () => {
  it('keeps CSS viewport queries on approved thresholds and range syntax', () => {
    const conditions = collectFiles(SRC_ROOT, CSS_EXTENSIONS).flatMap(file => (
      collectMediaConditions(file).map(condition => ({ file: location(file), condition }))
    ))
    const viewportQueries = conditions.filter(({ condition }) => widthGroups(condition).length > 0)

    expect(viewportQueries.length).toBeGreaterThan(30)
    expect(conditions.flatMap(({ file, condition }) => auditMediaQuery(condition).map(problem => ({
      file,
      condition,
      problem,
    })))).toEqual([])
  })

  it('keeps production matchMedia queries on approved thresholds and range syntax', () => {
    const calls = collectProductionMatchMediaCalls()
    const resolvedCalls = calls.filter((call): call is MatchMediaCall & { query: string } => call.query !== null)
    const unresolvedCalls = calls.filter(call => call.query === null)
    const widthCalls = resolvedCalls.filter(call => widthGroups(call.query).length > 0)

    expect(widthCalls.length).toBeGreaterThanOrEqual(8)
    expect(unresolvedCalls).toEqual([])
    expect(resolvedCalls.flatMap(call => auditMediaQuery(call.query).map(problem => ({
      file: location(call.file),
      expression: call.expression,
      problem,
    })))).toEqual([])
  })

  it('rejects legacy, non-range, unregistered and non-breakpoint queries', () => {
    expect(SINGLE_COMPARISON_RE.test('width < 640px')).toBe(true)
    expect(SINGLE_COMPARISON_RE.test('width >= 640px')).toBe(true)
    expect(SINGLE_COMPARISON_RE.test('width <= 900px')).toBe(false)
    expect(SINGLE_COMPARISON_RE.test('width > 900px')).toBe(false)
    expect(SINGLE_COMPARISON_RE.test('width < 39.5rem')).toBe(false)
    expect(INTERVAL_COMPARISON_RE.test('768px <= width < 1280px')).toBe(true)
    expect(INTERVAL_COMPARISON_RE.test('768px <= width <= 1279px')).toBe(false)

    expect(auditMediaQuery('screen and (max-width: 900px)')).toContain('legacy-width')
    expect(auditMediaQuery('(width < 601px)')).toContain('unapproved-threshold')
    expect(auditMediaQuery('(width < ${601}px)')).toContain('non-breakpoint-interpolation')
    expect(auditMediaQuery('(width < ${BREAKPOINTS.unknown}px)')).toContain('non-breakpoint-interpolation')
    expect(auditMediaQuery('(width <= 900px)')).toContain('direction')
    expect(auditMediaQuery('(width > 900px)')).toContain('direction')

    expect(auditMediaQuery('(width < ${BREAKPOINTS.sm}px)')).toEqual([])
    expect(auditMediaQuery('screen and (width >= ${BREAKPOINTS.lg}px)')).toEqual([])
    expect(auditMediaQuery('(768px <= width < 1280px)')).toEqual([])
  })

  it('does not use arbitrary min/max breakpoints in scripts', () => {
    const arbitrary = collectFiles(SRC_ROOT, SCRIPT_EXTENSIONS).flatMap(file => (
      [...readFileSync(file, 'utf8').matchAll(ARBITRARY_BREAKPOINT_RE)].map(match => (
        `${location(file)}: ${match[0]}`
      ))
    ))

    expect(arbitrary).toEqual([])
  })
})
