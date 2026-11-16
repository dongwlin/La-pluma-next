import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BREAKPOINTS } from '../shared/lib/breakpoints'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const APPROVED_THRESHOLDS = new Set<number>(Object.values(BREAKPOINTS))

const CSS_EXTENSIONS = new Set(['.css'])
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage'])

const MEDIA_AT_RULE_RE = /@media\s+([^{]+)\{/g
const LEGACY_WIDTH_FEATURE_RE = /\b(?:min|max)-width\s*:/
const WIDTH_FEATURE_RE = /\bwidth\b/
const PX_VALUE_RE = /(\d+(?:\.\d+)?)px/g
const TEMPLATE_EXPRESSION_RE = /\$\{[^}]*\}/g
const SINGLE_COMPARISON_RE = /^\(?\s*width\s*[<>]=?\s*\d+(?:\.\d+)?px\s*\)?$/
const INTERVAL_COMPARISON_RE = /^\(?\s*\d+(?:\.\d+)?px\s*<=\s*width\s*<\s*\d+(?:\.\d+)?px\s*\)?$/
const ARBITRARY_BREAKPOINT_RE = /\b(?:min|max)-\[[^\]]*\]/g
const MEDIA_FEATURE_LITERAL_RE = /(['"`])(\([^'"`]*\))\1/g
const MEDIA_FEATURE_NAME_RE = /\b(?:width|display-mode|prefers-|pointer|orientation|hover|resolution|scan|color)\b/

function collectFiles(dir: string, extensions: Set<string>): string[] {
  return readdirSync(dir).flatMap(entry => {
    if (IGNORED_DIRECTORIES.has(entry)) return []
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectFiles(path, extensions)
    return extensions.has(extname(path)) ? [path] : []
  })
}

function location(file: string): string {
  return relative(SRC_ROOT, file)
}

function collectMediaConditions(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(MEDIA_AT_RULE_RE)].flatMap(match => (
    match[1] ? [match[1].trim()] : []
  ))
}

function collectMediaFeatureLiterals(file: string): Array<{ query: string; template: boolean }> {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(MEDIA_FEATURE_LITERAL_RE)].flatMap(match => {
    const query = match[2]
    if (!query || !MEDIA_FEATURE_NAME_RE.test(query)) return []
    return [{ query, template: query.includes('${') }]
  })
}

function widthSegments(condition: string): string[] {
  return condition.split(',').map(segment => segment.trim()).filter(segment => WIDTH_FEATURE_RE.test(segment))
}

function numericThresholds(query: string): number[] {
  return [...query.matchAll(PX_VALUE_RE)].map(match => Number(match[1]))
}

describe('responsive breakpoint policy', () => {
  it('keeps CSS viewport queries on approved thresholds and range syntax', () => {
    const conditions = collectFiles(SRC_ROOT, CSS_EXTENSIONS).flatMap(file => (
      collectMediaConditions(file).map(condition => ({ file: location(file), condition }))
    ))
    const viewportQueries = conditions.filter(({ condition }) => WIDTH_FEATURE_RE.test(condition))

    expect(viewportQueries.length).toBeGreaterThan(30)
    expect(conditions.filter(({ condition }) => LEGACY_WIDTH_FEATURE_RE.test(condition))).toEqual([])
    expect(viewportQueries.filter(({ condition }) => (
      widthSegments(condition).some(segment => (
        !SINGLE_COMPARISON_RE.test(segment) && !INTERVAL_COMPARISON_RE.test(segment)
      ))
    ))).toEqual([])
    expect(viewportQueries.filter(({ condition }) => (
      numericThresholds(condition).some(threshold => !APPROVED_THRESHOLDS.has(threshold))
    ))).toEqual([])
  })

  it('keeps script media queries on approved thresholds and range syntax', () => {
    const literals = collectFiles(SRC_ROOT, SCRIPT_EXTENSIONS).flatMap(file => (
      collectMediaFeatureLiterals(file).map(literal => ({ file: location(file), ...literal }))
    ))
    const widthQueries = literals.filter(({ query }) => WIDTH_FEATURE_RE.test(query))

    expect(widthQueries.length).toBeGreaterThanOrEqual(8)
    expect(literals.filter(({ query }) => LEGACY_WIDTH_FEATURE_RE.test(query))).toEqual([])
    expect(widthQueries.filter(({ query, template }) => {
      const normalized = template ? query.replace(TEMPLATE_EXPRESSION_RE, '0') : query
      return widthSegments(normalized).some(segment => (
        !SINGLE_COMPARISON_RE.test(segment) && !INTERVAL_COMPARISON_RE.test(segment)
      ))
    })).toEqual([])
    expect(widthQueries.filter(({ query, template }) => (
      !template && numericThresholds(query).some(threshold => !APPROVED_THRESHOLDS.has(threshold))
    ))).toEqual([])
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
