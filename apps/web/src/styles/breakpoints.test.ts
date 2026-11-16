import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { BREAKPOINTS } from '../shared/lib/breakpoints'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BREAKPOINT_KEYS = new Set(Object.keys(BREAKPOINTS))
const APPROVED_THRESHOLDS = new Set<number>(Object.values(BREAKPOINTS))

const CSS_EXTENSIONS = new Set(['.css'])
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage'])
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx']

const MEDIA_AT_RULE_RE = /@media\s+([^{]+)\{/gi
const LEGACY_WIDTH_FEATURE_RE = /\b(?:min|max)-width\s*:/
const WIDTH_FEATURE_RE = /\bwidth\b/
const PX_VALUE_RE = /(\d+(?:\.\d+)?)px/g
const PAREN_GROUP_RE = /\(([^()]*)\)/g
const INTERPOLATION_RE = /\$\{([^}]*)\}/g
const DOTTED_BREAKPOINT_RE = /^BREAKPOINTS\.([A-Za-z_$][\w$]*)$/
const BRACKETED_BREAKPOINT_RE = /^BREAKPOINTS\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]$/
const SINGLE_COMPARISON_RE = /^width\s*(?:<|>=)\s*\d+(?:\.\d+)?px$/
const INTERVAL_COMPARISON_RE = /^\d+(?:\.\d+)?px\s*<=\s*width\s*<\s*\d+(?:\.\d+)?px$/
const ARBITRARY_BREAKPOINT_RE = /\b(?:min|max)-\[[^\]]*\]/g

type MediaQueryProblem =
  | 'legacy-width'
  | 'direction'
  | 'unapproved-threshold'
  | 'non-breakpoint-interpolation'

interface ConstantDeclaration {
  sourceFile: ts.SourceFile
  initializer: ts.Expression
}

interface ScriptAnalysis {
  file: string
  sourceFile: ts.SourceFile
  local: Map<string, ConstantDeclaration>
  exported: Map<string, ConstantDeclaration>
  calls: ts.CallExpression[]
}

interface ResolvedCall {
  file: string
  line: number
  expression: string
  query: string | null
  reason: string | null
}

interface ResolveScope {
  sourceFile: ts.SourceFile
  exported: Map<string, ConstantDeclaration>
  localByFile: Map<ts.SourceFile, Map<string, ConstantDeclaration>>
}

interface QueryResolution {
  query: string | null
  reason: string | null
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

function parseBreakpointKey(expression: string): string | null {
  const dotted = DOTTED_BREAKPOINT_RE.exec(expression)
  if (dotted?.[1] && BREAKPOINT_KEYS.has(dotted[1])) return dotted[1]
  const bracketed = BRACKETED_BREAKPOINT_RE.exec(expression)
  if (bracketed?.[2] && BREAKPOINT_KEYS.has(bracketed[2])) return bracketed[2]
  return null
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
  const loweredQuery = query.toLowerCase()
  if (LEGACY_WIDTH_FEATURE_RE.test(loweredQuery)) problems.add('legacy-width')

  for (const match of query.matchAll(INTERPOLATION_RE)) {
    if (!parseBreakpointKey((match[1] ?? '').trim())) problems.add('non-breakpoint-interpolation')
  }

  const staticQuery = loweredQuery.replace(INTERPOLATION_RE, 'EXPR')
  const normalizedQuery = loweredQuery.replace(INTERPOLATION_RE, '0')
  const groups = widthGroups(normalizedQuery)

  if (WIDTH_FEATURE_RE.test(loweredQuery) && groups.length === 0) problems.add('direction')

  for (const group of groups) {
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

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

function collectConstants(sourceFile: ts.SourceFile) {
  const local = new Map<string, ConstantDeclaration>()
  const exported = new Map<string, ConstantDeclaration>()

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declaration: ConstantDeclaration = { sourceFile, initializer: node.initializer }
      local.set(node.name.text, declaration)
      const statement = node.parent.parent
      if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
        exported.set(node.name.text, declaration)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { local, exported }
}

function isMatchMediaCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'matchMedia'
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'matchMedia'
}

function collectMatchMediaCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isMatchMediaCallee(node.expression)) calls.push(node)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return calls
}

function analyzeSource(file: string, source: string): ScriptAnalysis {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const { local, exported } = collectConstants(sourceFile)
  return { file, sourceFile, local, exported, calls: collectMatchMediaCalls(sourceFile) }
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function breakpointKeyOf(node: ts.Expression): string | null {
  const expression = unwrapExpression(node)
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'BREAKPOINTS'
    && ts.isIdentifier(expression.name)
    && BREAKPOINT_KEYS.has(expression.name.text)
  ) {
    return expression.name.text
  }
  if (
    ts.isElementAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'BREAKPOINTS'
  ) {
    const argument = expression.argumentExpression
    if (argument && ts.isStringLiteralLike(argument) && BREAKPOINT_KEYS.has(argument.text)) {
      return argument.text
    }
  }
  return null
}

function resolveQueryNode(node: ts.Expression, scope: ResolveScope, seen: Set<ts.Node>): QueryResolution {
  const expression = unwrapExpression(node)

  if (ts.isStringLiteralLike(expression)) return { query: expression.text, reason: null }

  if (ts.isTemplateExpression(expression)) {
    let query = expression.head.text
    for (const span of expression.templateSpans) {
      const key = breakpointKeyOf(span.expression)
      if (!key) {
        return { query: null, reason: `unsupported template substitution: ${span.expression.getText()}` }
      }
      query += '${BREAKPOINTS.' + key + '}' + span.literal.text
    }
    return { query, reason: null }
  }

  if (ts.isIdentifier(expression)) {
    const declaration = scope.localByFile.get(scope.sourceFile)?.get(expression.text)
      ?? scope.exported.get(expression.text)
    if (!declaration) return { query: null, reason: `unresolved identifier: ${expression.text}` }
    if (seen.has(declaration.initializer)) {
      return { query: null, reason: `cyclic constant: ${expression.text}` }
    }
    seen.add(declaration.initializer)
    return resolveQueryNode(declaration.initializer, { ...scope, sourceFile: declaration.sourceFile }, seen)
  }

  return { query: null, reason: `unsupported expression: ${ts.SyntaxKind[expression.kind]}` }
}

function resolveCalls(
  analysis: ScriptAnalysis,
  exported: Map<string, ConstantDeclaration>,
  localByFile: Map<ts.SourceFile, Map<string, ConstantDeclaration>>,
): ResolvedCall[] {
  return analysis.calls.map(call => {
    const line = analysis.sourceFile.getLineAndCharacterOfPosition(call.getStart(analysis.sourceFile)).line + 1
    const expression = call.getText(analysis.sourceFile)
    const argument = call.arguments[0]
    if (!argument) return { file: analysis.file, line, expression, query: null, reason: 'missing argument' }
    const resolution = resolveQueryNode(
      argument,
      { sourceFile: analysis.sourceFile, exported, localByFile },
      new Set(),
    )
    return { file: analysis.file, line, expression, query: resolution.query, reason: resolution.reason }
  })
}

function collectProductionAnalyses(): ScriptAnalysis[] {
  return collectFiles(SRC_ROOT, SCRIPT_EXTENSIONS)
    .filter(file => !isTestFile(file))
    .map(file => analyzeSource(file, readFileSync(file, 'utf8')))
}

function analyzeFixture(source: string): ResolvedCall[] {
  const analysis = analyzeSource('fixture.ts', source)
  return resolveCalls(analysis, new Map(), new Map([[analysis.sourceFile, analysis.local]]))
}

function firstCall(source: string): ResolvedCall {
  const calls = analyzeFixture(source)
  expect(calls).toHaveLength(1)
  const [call] = calls
  if (!call) throw new Error('missing matchMedia call')
  return call
}

describe('responsive breakpoint policy', () => {
  it('keeps CSS viewport queries on approved thresholds and range syntax', () => {
    const conditions = collectFiles(SRC_ROOT, CSS_EXTENSIONS).flatMap(file => (
      collectMediaConditions(file).map(condition => ({ file: location(file), condition }))
    ))
    const viewportQueries = conditions.filter(({ condition }) => widthGroups(condition.toLowerCase()).length > 0)

    expect(viewportQueries.length).toBeGreaterThan(30)
    expect(conditions.flatMap(({ file, condition }) => auditMediaQuery(condition).map(problem => ({
      file,
      condition,
      problem,
    })))).toEqual([])
  })

  it('audits every production matchMedia call', () => {
    const analyses = collectProductionAnalyses()
    const exported = new Map<string, ConstantDeclaration>()
    const localByFile = new Map<ts.SourceFile, Map<string, ConstantDeclaration>>()

    for (const analysis of analyses) {
      localByFile.set(analysis.sourceFile, analysis.local)
      for (const [name, declaration] of analysis.exported) exported.set(name, declaration)
    }

    const calls = analyses.flatMap(analysis => resolveCalls(analysis, exported, localByFile))
    const unsupportedCalls = calls.filter(call => call.query === null)
    const supportedCalls = calls.filter((call): call is ResolvedCall & { query: string } => call.query !== null)
    const widthCalls = supportedCalls.filter(call => widthGroups(call.query.toLowerCase()).length > 0)
    const widthCallKeys = new Set(widthCalls.map(call => `${call.file}:${call.expression}`))

    expect(widthCallKeys.size).toBeGreaterThanOrEqual(8)
    expect(unsupportedCalls).toEqual([])
    expect(supportedCalls.flatMap(call => auditMediaQuery(call.query).map(problem => ({
      file: location(call.file),
      line: call.line,
      expression: call.expression,
      problem,
    })))).toEqual([])
  })

  it('recognizes every matchMedia argument form or fails closed', () => {
    const trailingComma = firstCall("window.matchMedia('(width < 601px)',)")
    expect(trailingComma.query).toBe('(width < 601px)')
    expect(auditMediaQuery(trailingComma.query ?? '')).toContain('unapproved-threshold')

    const extraParentheses = firstCall("window.matchMedia(('(width < 602px)'))")
    expect(extraParentheses.query).toBe('(width < 602px)')
    expect(auditMediaQuery(extraParentheses.query ?? '')).toContain('unapproved-threshold')

    const multiline = firstCall("window.matchMedia\n  ('(width < 603px)')")
    expect(multiline.query).toBe('(width < 603px)')
    expect(auditMediaQuery(multiline.query ?? '')).toContain('unapproved-threshold')

    const asConst = firstCall("window.matchMedia('(width < 604px)' as const)")
    expect(asConst.query).toBe('(width < 604px)')
    expect(auditMediaQuery(asConst.query ?? '')).toContain('unapproved-threshold')

    expect(firstCall('window.matchMedia(objectQuery.mobile)').reason).toContain('unsupported')
    expect(firstCall('window.matchMedia(getQuery())').reason).toContain('unsupported')
    expect(firstCall("const concatConst = '(width < ' + '603px)'; window.matchMedia(concatConst)").reason)
      .toContain('unsupported')
  })

  it('accepts literal, template, constant, parenthesized and as-const queries', () => {
    const literal = firstCall("window.matchMedia('(width < 640px)')")
    expect(literal.query).toBe('(width < 640px)')
    expect(auditMediaQuery(literal.query ?? '')).toEqual([])

    const template = firstCall('window.matchMedia(`(width < ${BREAKPOINTS.sm}px)`)')
    expect(template.query).toBe('(width < ${BREAKPOINTS.sm}px)')
    expect(auditMediaQuery(template.query ?? '')).toEqual([])

    const bracketed = firstCall("window.matchMedia(`(width < ${BREAKPOINTS['sm']}px)`)")
    expect(bracketed.query).toBe('(width < ${BREAKPOINTS.sm}px)')
    expect(auditMediaQuery(bracketed.query ?? '')).toEqual([])

    const parenthesized = firstCall("window.matchMedia(('(width >= 1024px)'))")
    expect(parenthesized.query).toBe('(width >= 1024px)')
    expect(auditMediaQuery(parenthesized.query ?? '')).toEqual([])

    const asConst = firstCall("window.matchMedia('(width >= 1280px)' as const)")
    expect(asConst.query).toBe('(width >= 1280px)')
    expect(auditMediaQuery(asConst.query ?? '')).toEqual([])

    const constant = firstCall(
      "const DESKTOP_QUERY = `(width >= ${BREAKPOINTS.lg}px)`; window.matchMedia(DESKTOP_QUERY)",
    )
    expect(constant.query).toBe('(width >= ${BREAKPOINTS.lg}px)')
    expect(auditMediaQuery(constant.query ?? '')).toEqual([])
  })

  it('rejects legacy, non-range, unregistered, nested and uppercase queries', () => {
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
    expect(auditMediaQuery('(WIDTH < 641px)')).toContain('unapproved-threshold')
    expect(auditMediaQuery('(MAX-WIDTH: 900px)')).toContain('legacy-width')
    expect(auditMediaQuery('(width < calc(641px))')).toContain('direction')
    expect(auditMediaQuery('(width < min(641px, 900px))')).toContain('direction')

    const uppercaseThreshold = firstCall("window.matchMedia('(WIDTH < 605px)')")
    expect(auditMediaQuery(uppercaseThreshold.query ?? '')).toContain('unapproved-threshold')
    const uppercaseLegacy = firstCall("window.matchMedia('(MAX-WIDTH: 900px)')")
    expect(auditMediaQuery(uppercaseLegacy.query ?? '')).toContain('legacy-width')

    expect(auditMediaQuery('(width < ${BREAKPOINTS.sm}px)')).toEqual([])
    expect(auditMediaQuery('(width < ${BREAKPOINTS[\'sm\']}px)')).toEqual([])
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
