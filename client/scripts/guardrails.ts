/**
 * 依赖与职责护栏的分析核心。
 *
 * 这里只做静态事实判断，不运行应用、不读取 Query、不推断运行时所有权：
 * - 功能域公开面与分层方向：`app → features → shared`，跨域只能经 `index.ts` 根入口；
 * - 功能域依赖环：把 feature 目录折叠成节点，求强连通分量；
 * - 非页面微域 `task-execution` 不得反向依赖任何功能域；
 * - 页面文件不得直接持有传输、存储与轮询原语，但可以调用所属领域的容器与 hook；
 * - hooks / model / components / pages 的规模只作为辅助信号与预算提示。
 *
 * 规则边界与阈值依据见 docs/guardrails.md。测试文件不参与运行时依赖与规模统计，
 * 因为测试可以为了隔离而接触内部实现，不会进入生产包。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export interface SourceFile {
  /** 相对 `client/src` 的 POSIX 路径，例如 `features/task-execution/index.ts`。 */
  path: string
  source: string
}

export interface ImportEdge {
  from: string
  to: string
  specifier: string
}

export type GuardrailRule =
  | 'domain-cycle'
  | 'deep-import'
  | 'layer-direction'
  | 'task-execution-reverse'
  | 'page-transport'
  | 'page-storage'
  | 'page-polling'

export interface GuardrailViolation {
  rule: GuardrailRule
  file: string
  message: string
}

export interface DependencyAnalysis {
  edges: ImportEdge[]
  cycles: string[][]
  violations: GuardrailViolation[]
}

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx)$/
const PAGE_FILE_PATTERN = /^features\/[^/]+\/pages\/[^/]+\.(?:ts|tsx)$/
const SIZE_CATEGORY_PATTERN = /^features\/[^/]+\/(pages|hooks|model|components)\/.+\.(?:ts|tsx)$/

/** 这些全局对象只能出现在页面之外的领域容器/hook 中。 */
const TRANSPORT_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'])
const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage', 'indexedDB'])
const POLLING_GLOBALS = new Set(['setInterval'])

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath)
}

export function isPageFile(filePath: string): boolean {
  return PAGE_FILE_PATTERN.test(filePath) && !isTestFile(filePath)
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function parseSourceFile(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(file.path),
  )
}

/**
 * 取出静态 import/export、副作用 import 与动态 import 的模块说明符。
 * 注释和字符串字面量不会被误判。
 */
export function collectImportSpecifiers(source: string, filePath = 'sample.tsx'): string[] {
  const sourceFile = parseSourceFile({ path: filePath, source })
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArgument] = node.arguments
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) {
        specifiers.push(firstArgument.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

/**
 * 把模块说明符解析为 `client/src` 下的实际源码路径。
 *
 * 只处理别名（`@/`）和相对路径；外部包与样式等非 TS 资源返回 `null`，
 * 不进入依赖图。解析优先级与 TypeScript/Vite 的常见约定一致：
 * 精确文件、`.ts`、`.tsx`、目录 `index.ts`、目录 `index.tsx`。
 */
export function resolveImport(
  specifier: string,
  fromFile: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  const cleaned = specifier.split(/[?#]/)[0] ?? specifier
  let base: string

  if (cleaned.startsWith('@/')) {
    base = path.posix.normalize(cleaned.slice(2)).replace(/\/+$/, '')
  } else if (cleaned.startsWith('.')) {
    base = path.posix
      .normalize(path.posix.join(path.posix.dirname(fromFile), cleaned))
      .replace(/\/+$/, '')
  } else {
    return null
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate
  }
  return null
}

export function buildImportEdges(files: readonly SourceFile[]): ImportEdge[] {
  const knownFiles = new Set(files.map(file => file.path))
  const edges: ImportEdge[] = []

  for (const file of files) {
    for (const specifier of collectImportSpecifiers(file.source, file.path)) {
      const target = resolveImport(specifier, file.path, knownFiles)
      if (target && target !== file.path) {
        edges.push({ from: file.path, to: target, specifier })
      }
    }
  }

  return edges
}

function topLayerOf(filePath: string): 'app' | 'shared' | 'features' | 'root' {
  const top = filePath.split('/')[0]
  if (top === 'app' || top === 'shared' || top === 'features') return top
  return 'root'
}

function featureDomainOf(filePath: string): string | null {
  const [top, domain] = filePath.split('/')
  return top === 'features' && domain ? domain : null
}

function isFeatureIndex(filePath: string): { domain: string } | null {
  const match = /^features\/([^/]+)\/index\.tsx?$/.exec(filePath)
  return match?.[1] ? { domain: match[1] } : null
}

function cyclePathForComponent(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  component: ReadonlySet<string>,
): string[] {
  if (component.size === 1) {
    const [only] = component
    if (only && graph.get(only)?.has(only)) return [only, only]
    return [...component]
  }

  const start = [...component].sort()[0]
  if (!start) return [...component]

  const pathStack: string[] = []
  const onPath = new Set<string>()

  const visit = (node: string): string[] | null => {
    pathStack.push(node)
    onPath.add(node)

    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (!component.has(next)) continue
      if (next === start && pathStack.length > 1) {
        return [...pathStack, start]
      }
      if (onPath.has(next)) continue
      const found = visit(next)
      if (found) return found
    }

    pathStack.pop()
    onPath.delete(node)
    return null
  }

  return visit(start) ?? [...component].sort()
}

/**
 * 功能域依赖环检测：每个 SCC 输出一条可读的环路径。
 * 只使用 feature → feature 边；`shared → feature` 等分层违规由另一条规则报告。
 */
export function findDomainCycles(edges: readonly ImportEdge[]): string[][] {
  const graph = new Map<string, Set<string>>()

  for (const edge of edges) {
    const from = featureDomainOf(edge.from)
    const to = featureDomainOf(edge.to)
    if (!from || !to || from === to) continue
    let targets = graph.get(from)
    if (!targets) {
      targets = new Set()
      graph.set(from, targets)
    }
    targets.add(to)
  }

  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: Set<string>[] = []
  let nextIndex = 0

  const strongConnect = (node: string): void => {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        strongConnect(target)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!))
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = new Set<string>()
      let member = stack.pop()
      while (member !== undefined) {
        onStack.delete(member)
        component.add(member)
        if (member === node) break
        member = stack.pop()
      }
      components.push(component)
    }
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) strongConnect(node)
  }

  return components
    .filter((component) => {
      if (component.size > 1) return true
      const [only] = component
      return only !== undefined && graph.get(only)?.has(only) === true
    })
    .map(component => cyclePathForComponent(graph, component))
    .sort((a, b) => a.join('/').localeCompare(b.join('/')))
}

/**
 * 依赖与公开面检查。返回的违规同时包含域环、深路径、分层反向依赖，
 * 以及 `task-execution` 反向依赖其他功能域。
 */
export function analyzeDependencies(files: readonly SourceFile[]): DependencyAnalysis {
  const productionFiles = files.filter(file => !isTestFile(file.path))
  const edges = buildImportEdges(productionFiles)
  const violations: GuardrailViolation[] = []

  for (const edge of edges) {
    const fromLayer = topLayerOf(edge.from)
    const toLayer = topLayerOf(edge.to)

    // shared 只能依赖 shared 自身；feature 不能反向依赖 app。
    if (fromLayer === 'shared' && toLayer !== 'shared') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `shared 不得依赖 ${toLayer}：${edge.specifier}`,
      })
      continue
    }

    if (fromLayer === 'features' && toLayer === 'app') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `features 不得反向依赖 app：${edge.specifier}`,
      })
      continue
    }

    const fromDomain = featureDomainOf(edge.from)
    const toDomain = featureDomainOf(edge.to)

    if (fromDomain === 'task-execution' && toDomain && toDomain !== 'task-execution') {
      violations.push({
        rule: 'task-execution-reverse',
        file: edge.from,
        message: `task-execution 是非页面微域，只能依赖 shared，不得依赖 features/${toDomain}：${edge.specifier}`,
      })
    }

    if (toDomain) {
      const targetIsPublicEntry = isFeatureIndex(edge.to)?.domain === toDomain
      const usesRootAlias = edge.specifier === `@/features/${toDomain}`
      const isCrossDomain = fromDomain !== null && fromDomain !== toDomain
      const isOutsideFeature = fromLayer === 'app' || fromLayer === 'root'

      if ((isCrossDomain || isOutsideFeature) && (!targetIsPublicEntry || !usesRootAlias)) {
        violations.push({
          rule: 'deep-import',
          file: edge.from,
          message: `跨域必须经 @/features/${toDomain} 根入口，不得使用 ${edge.specifier}`,
        })
      } else if (fromDomain === toDomain && edge.specifier.startsWith('@/features/')) {
        violations.push({
          rule: 'deep-import',
          file: edge.from,
          message: `同一功能域内部请用相对路径，不得经 ${edge.specifier} 访问自身`,
        })
      }
    }
  }

  const cycles = findDomainCycles(edges)
  for (const cycle of cycles) {
    const cycleDomains = new Set(cycle)
    const closingEdge = edges.find(edge => {
      const from = featureDomainOf(edge.from)
      const to = featureDomainOf(edge.to)
      return from !== null && to !== null && cycleDomains.has(from) && cycleDomains.has(to)
    })
    violations.push({
      rule: 'domain-cycle',
      file: closingEdge?.from ?? `features/${cycle[0] ?? 'unknown'}`,
      message: `功能域依赖成环：${cycle.join(' → ')}`,
    })
  }

  return { edges, cycles, violations }
}

function isGlobalObjectExpression(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression)
    && (expression.text === 'window' || expression.text === 'globalThis' || expression.text === 'self')
}

function isPropertyName(node: ts.Identifier): boolean {
  const { parent } = node
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isQualifiedName(parent) && parent.right === node)
    || (ts.isJsxAttribute(parent) && parent.name === node)
  )
}

function pageRuleForGlobal(name: string): GuardrailRule | null {
  if (TRANSPORT_GLOBALS.has(name)) return 'page-transport'
  if (STORAGE_GLOBALS.has(name)) return 'page-storage'
  if (POLLING_GLOBALS.has(name)) return 'page-polling'
  return null
}

function collectPageGlobalViolations(file: SourceFile, violations: GuardrailViolation[]): void {
  const sourceFile = parseSourceFile(file)

  const report = (name: string, line: number): void => {
    const rule = pageRuleForGlobal(name)
    if (!rule) return
    const reason = rule === 'page-transport'
      ? '页面不得直接使用传输原语'
      : rule === 'page-storage'
        ? '页面不得直接读写浏览器存储'
        : '页面不得直接启动轮询'
    violations.push({
      rule,
      file: file.path,
      message: `${reason}（${name}，第 ${line} 行）；请交给领域容器、hook 或领域所有者`,
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isPropertyName(node) && pageRuleForGlobal(node.text)) {
      report(node.text, sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }

    if (
      ts.isPropertyAccessExpression(node)
      && isGlobalObjectExpression(node.expression)
      && ts.isIdentifier(node.name)
      && pageRuleForGlobal(node.name.text)
    ) {
      report(node.name.text, sourceFile.getLineAndCharacterOfPosition(node.name.getStart()).line + 1)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

function importsPageInfrastructure(
  specifier: string,
  resolved: string | null,
): boolean {
  if (specifier === '@tanstack/react-query' || specifier.startsWith('@tanstack/react-query/')) {
    return true
  }
  if (!resolved) return false
  return resolved === 'shared/api/index.ts'
    || resolved.startsWith('shared/api/')
    || resolved === 'shared/query/index.ts'
    || resolved.startsWith('shared/query/')
}

/**
 * 页面职责检查：页面只组合页头、工作区与领域容器，不亲自持有请求、存储或业务轮询。
 * 领域容器/hook（components、hooks）不受这些限制，因此页面调用所属领域的 hook 不会被误报。
 */
export function checkPageGuardrails(files: readonly SourceFile[]): GuardrailViolation[] {
  const knownFiles = new Set(files.map(file => file.path))
  const violations: GuardrailViolation[] = []

  for (const file of files) {
    if (!isPageFile(file.path)) continue

    for (const specifier of collectImportSpecifiers(file.source, file.path)) {
      const resolved = resolveImport(specifier, file.path, knownFiles)
      if (!importsPageInfrastructure(specifier, resolved)) continue
      violations.push({
        rule: 'page-transport',
        file: file.path,
        message: `页面不得直接依赖传输层或 Query 基础设施（${specifier}）；读取/写入交给领域容器与领域 Query`,
      })
    }

    collectPageGlobalViolations(file, violations)
  }

  return violations
}

export type SizeCategory = 'pages' | 'hooks' | 'model' | 'components'

export const SIZE_CATEGORIES: readonly SizeCategory[] = ['pages', 'hooks', 'model', 'components']

/** 首次生成预算或预算文件缺失时使用；常规检查以 size-budget.json 为准。 */
export const DEFAULT_SIZE_THRESHOLDS: Record<SizeCategory, number> = {
  pages: 60,
  hooks: 220,
  model: 340,
  components: 320,
}

export interface SizeEntry {
  path: string
  category: SizeCategory
  lines: number
}

export interface SizeCategoryReport {
  category: SizeCategory
  threshold: number
  fileCount: number
  totalLines: number
  medianLines: number
  largeFiles: SizeEntry[]
}

export interface SizeReport {
  categories: SizeCategoryReport[]
  totalLines: number
  totalFiles: number
  entries: SizeEntry[]
}

export interface SizeBaseline {
  thresholds: Record<SizeCategory, number>
  largeFiles: Record<SizeCategory, string[]>
}

export interface SizeBudgetResult {
  violations: string[]
  notes: string[]
}

export function countLines(source: string): number {
  if (source.length === 0) return 0
  const normalized = source.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n')
    ? normalized.split('\n').length - 1
    : normalized.split('\n').length
}

export function sizeCategoryOf(filePath: string): SizeCategory | null {
  if (isTestFile(filePath)) return null
  const match = SIZE_CATEGORY_PATTERN.exec(filePath)
  const category = match?.[1]
  return category === 'pages' || category === 'hooks' || category === 'model' || category === 'components'
    ? category
    : null
}

function medianOf(sortedValues: readonly number[]): number {
  if (sortedValues.length === 0) return 0
  const middle = Math.floor(sortedValues.length / 2)
  if (sortedValues.length % 2 === 1) return sortedValues[middle] ?? 0
  return Math.round(((sortedValues[middle - 1] ?? 0) + (sortedValues[middle] ?? 0)) / 2)
}

export function analyzeSize(
  files: readonly SourceFile[],
  thresholds: Record<SizeCategory, number>,
): SizeReport {
  const entries: SizeEntry[] = []

  for (const file of files) {
    const category = sizeCategoryOf(file.path)
    if (!category) continue
    entries.push({ path: file.path, category, lines: countLines(file.source) })
  }

  const categories = SIZE_CATEGORIES.map((category) => {
    const categoryEntries = entries.filter(entry => entry.category === category)
    const lines = categoryEntries.map(entry => entry.lines).sort((a, b) => a - b)
    const threshold = thresholds[category]
    return {
      category,
      threshold,
      fileCount: categoryEntries.length,
      totalLines: lines.reduce((sum, value) => sum + value, 0),
      medianLines: medianOf(lines),
      largeFiles: categoryEntries
        .filter(entry => entry.lines > threshold)
        .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
    }
  })

  return {
    categories,
    totalLines: entries.reduce((sum, entry) => sum + entry.lines, 0),
    totalFiles: entries.length,
    entries,
  }
}

/**
 * 规模预算只冻结「超过阈值的大文件集合」，不逐行限制正常增长：
 * - 新增一个超过本类阈值、且不在基线中的文件 → 失败，防止把页面逻辑搬进新 hook/model；
 * - 基线文件降到阈值下或删除 → 只提示，可择机收紧基线；
 * - 各类总行数只报告，不作为失败条件。
 */
export function evaluateSizeBudget(report: SizeReport, baseline: SizeBaseline): SizeBudgetResult {
  const violations: string[] = []
  const notes: string[] = []
  const entriesByPath = new Map(report.entries.map(entry => [entry.path, entry]))

  for (const categoryReport of report.categories) {
    const { category } = categoryReport
    const baselineFiles = new Set(baseline.largeFiles[category] ?? [])
    const currentLarge = new Set(categoryReport.largeFiles.map(entry => entry.path))

    for (const entry of categoryReport.largeFiles) {
      if (baselineFiles.has(entry.path)) continue
      violations.push(
        `新增超阈值文件：${entry.path}（${category} 阈值 ${categoryReport.threshold} 行，当前 ${entry.lines} 行）`,
      )
    }

    for (const baselinePath of baselineFiles) {
      if (currentLarge.has(baselinePath)) continue
      const entry = entriesByPath.get(baselinePath)
      notes.push(
        entry
          ? `已回落到阈值以下：${baselinePath}（${category}，当前 ${entry.lines} 行）`
          : `基线文件已不存在：${baselinePath}（${category}）`,
      )
    }
  }

  return { violations, notes }
}

/** 递归读取 `src` 下的 TS/TSX 源文件，路径统一为相对 src 根的 POSIX 形式。 */
export async function readSourceTree(srcRoot: string): Promise<SourceFile[]> {
  const files: SourceFile[] = []

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name)) continue
      files.push({
        path: path.relative(srcRoot, absolute).split(path.sep).join('/'),
        source: await readFile(absolute, 'utf8'),
      })
    }
  }

  await walk(srcRoot)
  return files
}
