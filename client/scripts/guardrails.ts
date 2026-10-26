/**
 * 依赖与职责护栏的分析核心。
 *
 * 这里只做静态事实判断，不运行应用、不读取 Query、不推断运行时所有权：
 * - 功能域公开面与分层方向：`app → pages → features → shared`，跨域只能经 `index.ts` 根入口；
 * - 页面由 `src/pages/<domain>/` 持有，只向下组合功能域与 shared；
 * - 功能域依赖环：把 feature 目录折叠成节点，求强连通分量；
 * - 非页面微域 `task-execution` 不得反向依赖任何功能域；
 * - 页面文件不得直接持有传输、存储与轮询原语，但可以调用所属领域的容器与 hook；
 * - hooks / model / components / pages 的规模作为辅助信号：新增超阈值文件与
 *   同域页面搬移（80% 阈值）会按预算失败，其余只报告。
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

export interface ImportBinding {
  specifier: string
  /** 具名导入使用导出名；默认/命名空间导入分别为 `default` / `*`。 */
  imported: string
  /** 页面内实际使用的本地名，用于分析命名空间导入的成员访问。 */
  localName: string
  typeOnly: boolean
}

export interface ImportReference {
  specifier: string
  /** 整条 import/export 都是类型时跳过页面运行时检查。 */
  typeOnly: boolean
}

export interface ReExport {
  exportedName: string
  /** 本地再导出的本地名：`export { local as exported }` 中为 local。 */
  localName?: string
  /** `null` 表示本地 `export { ... }`，来源需沿同文件的 import 解析。 */
  specifier: string | null
  typeOnly: boolean
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
const PAGE_FILE_PATTERN = /^pages\/[^/]+\/[^/]+\.(?:ts|tsx)$/
const SIZE_CATEGORY_PATTERN = /^(?:features\/[^/]+\/(hooks|model|components)|pages\/[^/]+)\/.+\.(?:ts|tsx)$/

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

function isTypeOnlyImportDeclaration(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  // 副作用 import 没有 importClause，但它仍然会在运行时加载模块。
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const namedBindings = clause.namedBindings
  if (!namedBindings || ts.isNamespaceImport(namedBindings)) return false
  return namedBindings.elements.length > 0
    && namedBindings.elements.every(element => element.isTypeOnly)
}

function isTypeOnlyExportDeclaration(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return !!clause
    && ts.isNamedExports(clause)
    && clause.elements.length > 0
    && clause.elements.every(element => element.isTypeOnly)
}

/**
 * 取出静态 import/export、副作用 import 与动态 import 的模块说明符，
 * 同时保留“整条导入只是类型”的信息，供页面职责检查使用。
 * 注释和字符串字面量不会被误判。
 */
export function collectImportReferences(source: string, filePath = 'sample.tsx'): ImportReference[] {
  const sourceFile = parseSourceFile({ path: filePath, source })
  const references: ImportReference[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyImportDeclaration(node),
      })
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyExportDeclaration(node),
      })
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArgument] = node.arguments
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) {
        references.push({ specifier: firstArgument.text, typeOnly: false })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

export function collectImportSpecifiers(source: string, filePath = 'sample.tsx'): string[] {
  return collectImportReferences(source, filePath).map(reference => reference.specifier)
}

/**
 * 取出 import 的具名绑定。页面职责检查用它在公开面 import 中区分
 * “领域端点”与领域 hook/组件，避免只拦字符串路径却放过 feature 根转发。
 */
export function collectImportBindings(source: string, filePath = 'sample.tsx'): ImportBinding[] {
  const sourceFile = parseSourceFile({ path: filePath, source })
  const bindings: ImportBinding[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const clause = statement.importClause
    if (!clause) continue
    const specifier = statement.moduleSpecifier.text
    const declarationTypeOnly = clause.isTypeOnly

    if (clause.name) {
      bindings.push({
        specifier,
        imported: 'default',
        localName: clause.name.text,
        typeOnly: declarationTypeOnly,
      })
    }

    const namedBindings = clause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.push({
        specifier,
        imported: '*',
        localName: namedBindings.name.text,
        typeOnly: declarationTypeOnly,
      })
      continue
    }

    for (const element of namedBindings.elements) {
      bindings.push({
        specifier,
        imported: element.propertyName?.text ?? element.name.text,
        localName: element.name.text,
        typeOnly: declarationTypeOnly || element.isTypeOnly,
      })
    }
  }

  return bindings
}

/**
 * 取出公开面的再导出：
 * - `export { ... } from './module'`、`export * from './module'`
 *   与 `export * as ns from './module'`；
 * - 本地 `export { local }` 没有模块说明符，记录 `localName`，
 *   由调用方沿同文件的 import 解析来源。
 */
export function collectReExports(source: string, filePath = 'sample.ts'): ReExport[] {
  const sourceFile = parseSourceFile({ path: filePath, source })
  const reExports: ReExport[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue

    const clause = statement.exportClause
    if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      if (!clause) {
        reExports.push({ exportedName: '*', specifier, typeOnly: statement.isTypeOnly })
        continue
      }

      if (ts.isNamespaceExport(clause)) {
        reExports.push({
          exportedName: clause.name.text,
          specifier,
          typeOnly: statement.isTypeOnly,
        })
        continue
      }

      if (!ts.isNamedExports(clause)) continue
      for (const element of clause.elements) {
        reExports.push({
          exportedName: element.name.text,
          specifier,
          typeOnly: statement.isTypeOnly || element.isTypeOnly,
        })
      }
      continue
    }

    // 本地再导出：`import { x } from './api'; export { x }`。
    if (!clause || !ts.isNamedExports(clause)) continue
    for (const element of clause.elements) {
      reExports.push({
        exportedName: element.name.text,
        localName: element.propertyName?.text ?? element.name.text,
        specifier: null,
        typeOnly: statement.isTypeOnly || element.isTypeOnly,
      })
    }
  }

  return reExports
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

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, names)
  }
}

/**
 * 递归收集一个模块实际导出的运行时名字，用于展开 `export * from './api'`。
 * 只做静态声明扫描，不执行类型检查；类型声明与 `export type` 不计入端点集合。
 */
function collectModuleExportedNames(
  filePath: string,
  filesByPath: ReadonlyMap<string, SourceFile>,
  knownFiles: ReadonlySet<string>,
  seen: Set<string>,
): Set<string> {
  const names = new Set<string>()
  if (seen.has(filePath)) return names
  seen.add(filePath)

  const file = filesByPath.get(filePath)
  if (!file) return names
  const sourceFile = parseSourceFile(file)

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add('default')
      continue
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names)
      }
      continue
    }

    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement))
      && hasExportModifier(statement)
      && statement.name
    ) {
      names.add(statement.name.text)
      continue
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue

    if (!statement.exportClause) {
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const target = resolveImport(statement.moduleSpecifier.text, filePath, knownFiles)
        if (target) {
          for (const name of collectModuleExportedNames(target, filesByPath, knownFiles, seen)) {
            names.add(name)
          }
        }
      }
      continue
    }

    if (ts.isNamespaceExport(statement.exportClause)) {
      names.add(statement.exportClause.name.text)
      continue
    }

    if (!ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) names.add(element.name.text)
    }
  }

  return names
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

function topLayerOf(filePath: string): 'app' | 'pages' | 'shared' | 'features' | 'root' {
  const top = filePath.split('/')[0]
  if (top === 'app' || top === 'pages' || top === 'shared' || top === 'features') return top
  return 'root'
}

function featureDomainOf(filePath: string): string | null {
  const [top, domain] = filePath.split('/')
  return top === 'features' && domain ? domain : null
}

/** 页面路径 `pages/<domain>/...` 的所属领域；页面只组合对应功能域的公开面。 */
function pageDomainOf(filePath: string): string | null {
  const match = /^pages\/([^/]+)\//.exec(filePath)
  return match?.[1] ?? null
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

    if (fromLayer === 'features' && toLayer === 'pages') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `features 不得反向依赖 pages：${edge.specifier}`,
      })
      continue
    }

    if (fromLayer === 'pages' && toLayer === 'app') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `pages 不得反向依赖 app：${edge.specifier}`,
      })
      continue
    }

    if (fromLayer === 'pages' && toLayer === 'root') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `pages 不得依赖根入口模块：${edge.specifier}`,
      })
      continue
    }

    if (fromLayer === 'features' && toLayer === 'root') {
      violations.push({
        rule: 'layer-direction',
        file: edge.from,
        message: `features 不得依赖根入口模块：${edge.specifier}`,
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
      const isOutsideFeature = fromLayer === 'app' || fromLayer === 'pages' || fromLayer === 'root'

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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
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

/** 属性/字面量下标访问的静态成员名；计算表达式返回 `null`。 */
function staticMemberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null
  }
  if (!node.argumentExpression) return null
  const argument = unwrapExpression(node.argumentExpression)
  return ts.isStringLiteralLike(argument) ? argument.text : null
}

const GLOBAL_OBJECT_NAMES = new Set(['window', 'globalThis', 'self'])
/** 这些属性返回同一个 Window 代理对象：`window.top`、`self.parent`、`window.frames`。 */
const WINDOW_PROXY_PROPERTIES = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames'])

/** `document`、`window.document` 与 `globalThis['document']` 都指向文档对象。 */
function isDocumentObjectExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) return unwrapped.text === 'document'
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return staticMemberName(unwrapped) === 'document'
      && isGlobalObjectExpression(unwrapped.expression)
  }
  return false
}

/**
 * `document.defaultView`（含 `window.document.defaultView` 等属性链）是 Window；
 * `document` 本身不是全局对象。
 */
function isDocumentDefaultView(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return false
  }
  if (staticMemberName(unwrapped) !== 'defaultView') return false
  return isDocumentObjectExpression(unwrapped.expression)
}

/**
 * 判断表达式是否指向浏览器全局对象。除裸 `window`/`globalThis`/`self` 外，
 * 也接受 Window 代理属性链（`window.window`、`window.top`、`self.parent`）
 * 与 `document.defaultView`：这些表达式仍指向同一个全局对象。
 *
 * 属性/下标访问先解包 `as`/括号/非空/satisfies 再取成员名，
 * 因此 `window.window`、`window[('window')]` 与 `(window as any).top`
 * 都会继续按代理链递归判断，而不是只认裸标识符。
 */
function isGlobalObjectExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression)
  if (isDocumentDefaultView(unwrapped)) return true
  if (ts.isIdentifier(unwrapped)) return GLOBAL_OBJECT_NAMES.has(unwrapped.text)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const member = staticMemberName(unwrapped)
    return member !== null
      && WINDOW_PROXY_PROPERTIES.has(member)
      && isGlobalObjectExpression(unwrapped.expression)
  }
  return false
}

function isPropertyName(node: ts.Identifier): boolean {
  const { parent } = node
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isMethodSignature(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isGetAccessorDeclaration(parent) && parent.name === node)
    || (ts.isSetAccessorDeclaration(parent) && parent.name === node)
    || (ts.isQualifiedName(parent) && parent.right === node)
    || (ts.isJsxAttribute(parent) && parent.name === node)
  )
}

/**
 * 判断节点是否位于赋值解构左侧，可穿过嵌套对象/数组模式与包装表达式。
 * 用于把 `({ a: { fetch } } = props)` 中的简写属性名识别为写入目标，
 * 而不是对全局对象的引用。
 */
function isAssignmentPatternExpression(node: ts.Node): boolean {
  const { parent } = node

  if (ts.isBinaryExpression(parent)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node
  }

  if (
    ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)
    || ts.isSatisfiesExpression(parent)
  ) {
    return isAssignmentPatternExpression(parent)
  }

  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return isAssignmentPatternExpression(parent)
  }

  if (ts.isObjectLiteralExpression(parent) && parent.properties.some(property => property === node)) {
    return isAssignmentPatternExpression(parent)
  }

  if (ts.isArrayLiteralExpression(parent) && parent.elements.some(element => element === node)) {
    return isAssignmentPatternExpression(parent)
  }

  return false
}

/** 赋值解构左侧的简写属性名是写入目标，不是全局引用。 */
function isAssignmentPatternShorthand(node: ts.Identifier): boolean {
  const property = node.parent
  return ts.isShorthandPropertyAssignment(property)
    && property.name === node
    && isAssignmentPatternExpression(property)
}

/** 声明名、参数名与解构绑定不是对全局对象的引用。 */
function isBindingName(node: ts.Identifier): boolean {
  const { parent } = node
  return (
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isFunctionExpression(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node)
    || (ts.isClassExpression(parent) && parent.name === node)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === node)
    || (ts.isInterfaceDeclaration(parent) && parent.name === node)
    || (ts.isEnumDeclaration(parent) && parent.name === node)
    || (ts.isTypeParameterDeclaration(parent) && parent.name === node)
    || (ts.isImportClause(parent) && parent.name === node)
    || (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isNamespaceImport(parent) && parent.name === node)
    || (ts.isImportEqualsDeclaration(parent) && parent.name === node)
    || (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
  )
}

/** 解构键名：标识符、字符串字面量或字面量计算属性（`['fetch']`）。 */
function literalPropertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression)
    return ts.isStringLiteralLike(expression) ? expression.text : null
  }
  return null
}

/** 解构键名：`{ fetch: f }` 取 fetch，`{ fetch }` 取 fetch。 */
function bindingElementKey(node: ts.BindingElement): string | null {
  if (node.propertyName) return literalPropertyName(node.propertyName)
  return ts.isIdentifier(node.name) ? node.name.text : null
}

/** 赋值解构左侧的键名：`({ fetch: f } = window)` 取 fetch。 */
function assignmentPropertyKey(
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): string | null {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text
  return literalPropertyName(node.name)
}

/**
 * 找到解构目标实际解构的表达式。覆盖：
 * - 变量声明：`const { fetch: f } = window`
 * - 参数默认值：`function f({ fetch } = window)`
 * - 外层解构元素默认值：`const { g: { fetch } = window } = props`
 * - 赋值解构：`({ fetch: f } = window)`、`({ a: { fetch } } = window.window)`
 *
 * 绑定模式沿 `ObjectBindingPattern`/`ArrayBindingPattern` 向上找初值；
 * 赋值模式沿对象/数组字面量与包装表达式向上，只接受作为 `=` 左值的模式，
 * 因此 `x = { fetch: f }` 这类普通对象字面量不会被当作解构来源。
 */
function findDestructuringSource(
  node: ts.BindingElement | ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): ts.Expression | undefined {
  if (ts.isBindingElement(node)) {
    let current: ts.Node = node

    while (
      ts.isBindingElement(current)
      || ts.isObjectBindingPattern(current)
      || ts.isArrayBindingPattern(current)
    ) {
      if (ts.isBindingElement(current) && current.initializer) return current.initializer
      const { parent } = current
      if (ts.isVariableDeclaration(parent) && parent.name === current) return parent.initializer
      if (ts.isParameter(parent) && parent.name === current) return parent.initializer
      current = parent
    }

    return undefined
  }

  let current: ts.Node = node

  while (true) {
    const { parent } = current
    if (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    ) {
      current = parent
      continue
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      current = parent
      continue
    }
    if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) {
      current = parent
      continue
    }
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.left === current
    ) {
      return parent.right
    }
    return undefined
  }
}

function unwrappedIdentifierName(expression: ts.Expression | undefined): string | null {
  if (!expression) return null
  const unwrapped = unwrapExpression(expression)
  return ts.isIdentifier(unwrapped) ? unwrapped.text : null
}

/** 取出回调函数本体，解开 `as`/括号/非空/satisfies 包装（`.then((m) => ...)`）。 */
function functionExpressionOf(
  expression: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expression) return null
  const unwrapped = unwrapExpression(expression)
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped) ? unwrapped : null
}

/**
 * 收集某个局部名字（命名空间变量、动态导入结果或它们在本文件中的别名）
 * 实际访问的模块成员。会解开 as/括号/非空/satisfies 包装，跟随变量、参数、
 * 解构默认值、赋值解构与简单赋值别名，并递归进入 `.then` 回调。
 *
 * 这不是完整的控制流或作用域分析：只跟踪本文件内以同一名字接收的值，
 * 把名字传给其他函数或经对象字段转存时无法判定。
 */
function collectPropertyUsage(root: ts.Node, identifierName: string): Set<string> {
  const names = new Set<string>()
  const tracked = new Set([identifierName])

  const isTrackedExpression = (expression: ts.Expression | undefined): boolean => {
    const name = unwrappedIdentifierName(expression)
    return name !== null && tracked.has(name)
  }

  const trackBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      tracked.add(name.text)
      return
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const key of collectObjectBindingKeys(name)) names.add(key)
    }
  }

  let changed = true
  while (changed) {
    const trackedBefore = tracked.size
    const namesBefore = names.size

    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        && isTrackedExpression(node.expression)
      ) {
        const member = staticMemberName(node)
        if (member) names.add(member)
      }

      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        && node.initializer
        && isTrackedExpression(node.initializer)
      ) {
        trackBinding(node.name)
      }

      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && isTrackedExpression(node.right)
      ) {
        const left = unwrapExpression(node.left)
        if (ts.isIdentifier(left)) {
          tracked.add(left.text)
        } else if (ts.isObjectLiteralExpression(left)) {
          for (const key of collectObjectLiteralKeys(left)) names.add(key)
        }
      }

      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'then'
        && isTrackedExpression(node.expression.expression)
      ) {
        const callback = functionExpressionOf(node.arguments[0])
        if (callback) {
          for (const name of collectCallbackModuleUsage(callback)) names.add(name)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(root)
    changed = tracked.size !== trackedBefore || names.size !== namesBefore
  }

  return names
}

/** 收集对象解构模式中的属性名（含嵌套层），例如 `{ a: { fetch } }` 仍取 fetch。 */
function collectObjectBindingKeys(pattern: ts.ObjectBindingPattern): Set<string> {
  const names = new Set<string>()

  const visit = (current: ts.ObjectBindingPattern | ts.ArrayBindingPattern): void => {
    for (const element of current.elements) {
      if (!ts.isBindingElement(element)) continue
      const key = bindingElementKey(element)
      if (key) names.add(key)
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        visit(element.name)
      }
    }
  }

  visit(pattern)
  return names
}

/** 收集赋值解构左侧对象字面量中的属性名（含嵌套层）。 */
function collectObjectLiteralKeys(expression: ts.Expression): Set<string> {
  const names = new Set<string>()
  const unwrapped = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(unwrapped)) return names

  for (const property of unwrapped.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text)
      continue
    }
    if (!ts.isPropertyAssignment(property)) continue
    const key = assignmentPropertyKey(property)
    if (key) names.add(key)
    for (const name of collectObjectLiteralKeys(property.initializer)) names.add(name)
  }

  return names
}

function collectBindingUsage(name: ts.BindingName, root: ts.Node): Set<string> {
  if (ts.isIdentifier(name)) return collectPropertyUsage(root, name.text)
  if (ts.isObjectBindingPattern(name)) return collectObjectBindingKeys(name)
  return new Set()
}

function collectCallbackModuleUsage(callback: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const [parameter] = callback.parameters
  if (!parameter) return new Set()
  return collectBindingUsage(parameter.name, callback.body)
}

function climbThroughExpressionWrappers(node: ts.Node): ts.Node {
  let current = node
  while (
    current.parent
    && (
      ts.isAwaitExpression(current.parent)
      || ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isTypeAssertionExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent)
    )
  ) {
    current = current.parent
  }
  return current
}

function collectDynamicImportUsedNames(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): Set<string> {
  const receiver = climbThroughExpressionWrappers(call)
  const { parent } = receiver

  if (
    ts.isPropertyAccessExpression(parent)
    && parent.expression === receiver
    && parent.name.text === 'then'
    && ts.isCallExpression(parent.parent)
  ) {
    const callback = functionExpressionOf(parent.parent.arguments[0])
    if (callback) {
      return collectCallbackModuleUsage(callback)
    }
  }

  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === receiver
  ) {
    const member = staticMemberName(parent)
    return member ? new Set([member]) : new Set()
  }

  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent))
    && parent.initializer === receiver
  ) {
    return collectBindingUsage(parent.name, sourceFile)
  }

  if (
    ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === receiver
  ) {
    const left = unwrapExpression(parent.left)
    if (ts.isIdentifier(left)) return collectPropertyUsage(sourceFile, left.text)
    if (ts.isObjectLiteralExpression(left)) return collectObjectLiteralKeys(left)
  }

  return new Set()
}

interface DynamicImportUsage {
  specifier: string
  usedNames: Set<string>
}

function collectDynamicImportUsages(sourceFile: ts.SourceFile): DynamicImportUsage[] {
  const usages: DynamicImportUsage[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifierArgument] = node.arguments
      if (specifierArgument && ts.isStringLiteralLike(specifierArgument)) {
        usages.push({
          specifier: specifierArgument.text,
          usedNames: collectDynamicImportUsedNames(node, sourceFile),
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return usages
}

function pageRuleForGlobal(name: string): GuardrailRule | null {
  if (TRANSPORT_GLOBALS.has(name)) return 'page-transport'
  if (STORAGE_GLOBALS.has(name)) return 'page-storage'
  if (POLLING_GLOBALS.has(name)) return 'page-polling'
  return null
}

/**
 * 收集模块级值绑定名（import 与顶层变量/函数/类/枚举/模块），用于放行
 * `import { fetch } from '../model/http'; fetch()` 这类同名本地 helper。
 * 只做模块级近似，不解析嵌套作用域；同名声明会放行整个文件的裸引用，
 * 但若初值来自 `window.fetch` 等全局访问，仍会由属性/解构分支报出。
 */
function collectModuleValueNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) names.add(clause.name.text)
      const namedBindings = clause.namedBindings
      if (!namedBindings) continue
      if (ts.isNamespaceImport(namedBindings)) {
        names.add(namedBindings.name.text)
        continue
      }
      for (const element of namedBindings.elements) {
        if (!element.isTypeOnly) names.add(element.name.text)
      }
      continue
    }

    if (ts.isImportEqualsDeclaration(statement)) {
      names.add(statement.name.text)
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names)
      }
      continue
    }

    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isModuleDeclaration(statement))
      && statement.name
    ) {
      names.add(statement.name.text)
    }
  }

  return names
}

function collectPageGlobalViolations(file: SourceFile, violations: GuardrailViolation[]): void {
  const sourceFile = parseSourceFile(file)
  const reported = new Set<string>()
  const moduleValueNames = collectModuleValueNames(sourceFile)

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const report = (name: string, line: number): void => {
    const rule = pageRuleForGlobal(name)
    if (!rule) return
    // 同一个原语可能同时命中解构键与裸标识符（例如 `({ fetch } = window)`），
    // 同一行只报一次，避免同一处使用产生重复违规。
    const key = `${rule}:${line}:${name}`
    if (reported.has(key)) return
    reported.add(key)
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
    // 变量声明、参数默认值与赋值解构共用同一套来源解析：
    // `const { fetch: f } = window.window`、`({ fetch: f } = window)`。
    if (ts.isBindingElement(node)) {
      const key = bindingElementKey(node)
      const source = findDestructuringSource(node)
      if (key && source && isGlobalObjectExpression(source) && pageRuleForGlobal(key)) {
        report(key, lineOf(node))
      }
    }

    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = assignmentPropertyKey(node)
      const source = findDestructuringSource(node)
      if (key && source && isGlobalObjectExpression(source) && pageRuleForGlobal(key)) {
        report(key, lineOf(node))
      }
    }

    // 类型别名、类型引用与 `typeof fetch` 的 TypeQuery 都不会在运行时取得原语；
    // `typeof window.fetch` 同样不能当作页面持有传输能力的证据。
    if (!ts.isPartOfTypeNode(node) && !(node.parent && ts.isTypeQueryNode(node.parent))) {
      if (
        ts.isIdentifier(node)
        && !isPropertyName(node)
        && !isBindingName(node)
        && !isAssignmentPatternShorthand(node)
        && !moduleValueNames.has(node.text)
        && pageRuleForGlobal(node.text)
      ) {
        report(node.text, lineOf(node))
      }

      if (
        ts.isPropertyAccessExpression(node)
        && isGlobalObjectExpression(node.expression)
        && ts.isIdentifier(node.name)
        && pageRuleForGlobal(node.name.text)
      ) {
        report(node.name.text, lineOf(node.name))
      }

      if (ts.isElementAccessExpression(node) && isGlobalObjectExpression(node.expression)) {
        const argument = node.argumentExpression
          ? unwrapExpression(node.argumentExpression)
          : undefined
        if (argument && ts.isStringLiteralLike(argument) && pageRuleForGlobal(argument.text)) {
          report(argument.text, lineOf(argument))
        }
      }
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
 * 收集同文件 import 的本地名到模块说明符映射（含 default、namespace 与命名导入），
 * 用于解析 `import run from './api'; export { run }`、
 * `import * as api from './api'; export { api }`、
 * `import { x as local } from './api'; export { local }` 等本地再导出。
 */
function collectLocalImportSources(sourceFile: ts.SourceFile): Map<string, string> {
  const sources = new Map<string, string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    const specifier = statement.moduleSpecifier.text

    if (clause.name) sources.set(clause.name.text, specifier)

    const namedBindings = clause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      sources.set(namedBindings.name.text, specifier)
      continue
    }

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue
      sources.set(element.name.text, specifier)
    }
  }

  return sources
}

/**
 * 收集各 feature 公开面中来自 `api/` 的导出名。
 *
 * 只禁 `@/features/x/api` 深路径不足以阻止页面直接调用端点：公开面可以把
 * `executeScheduleNow`、`saveUserConfig` 等端点再导出，也可能使用
 * `export * from './api'` 或同文件 `import ... from './api'; export { ... }`
 * 的本地命名/默认/命名空间转发。页面检查沿公开面定位来源，仍允许同一条公开面导出的领域 hook/组件。
 */
function buildPublicApiExports(files: readonly SourceFile[]): Map<string, Set<string>> {
  const filesByPath = new Map(files.map(file => [file.path, file]))
  const knownFiles = new Set(filesByPath.keys())
  const apiExports = new Map<string, Set<string>>()

  const addExport = (domain: string, name: string): void => {
    let names = apiExports.get(domain)
    if (!names) {
      names = new Set()
      apiExports.set(domain, names)
    }
    names.add(name)
  }

  for (const file of files) {
    const domain = /^features\/([^/]+)\/index\.tsx?$/.exec(file.path)?.[1]
    if (!domain) continue

    const sourceFile = parseSourceFile(file)
    const localImportSources = collectLocalImportSources(sourceFile)

    for (const reExport of collectReExports(file.source, file.path)) {
      if (reExport.typeOnly) continue
      const specifier = reExport.specifier
        ?? (reExport.localName ? localImportSources.get(reExport.localName) : undefined)
      if (!specifier) continue
      const target = resolveImport(specifier, file.path, knownFiles)
      if (!target?.startsWith(`features/${domain}/api/`)) continue

      if (reExport.exportedName === '*') {
        for (const name of collectModuleExportedNames(target, filesByPath, knownFiles, new Set())) {
          // `export *` 不转发 default；default 可能来自页面组件，不能当作端点。
          if (name !== 'default') addExport(domain, name)
        }
      } else {
        addExport(domain, reExport.exportedName)
      }
    }

    // 本地默认转发：`import { executeScheduleNow } from './api'; export default executeScheduleNow`。
    for (const statement of sourceFile.statements) {
      if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue
      const localName = unwrappedIdentifierName(statement.expression)
      const specifier = localName ? localImportSources.get(localName) : undefined
      if (!specifier) continue
      const target = resolveImport(specifier, file.path, knownFiles)
      if (target?.startsWith(`features/${domain}/api/`)) addExport(domain, 'default')
    }
  }

  return apiExports
}

/**
 * 页面职责检查：页面只组合页头、工作区与领域容器，不亲自持有请求、存储或业务轮询。
 * 领域容器/hook（components、hooks）不受这些限制，因此页面调用所属领域的 hook 不会被误报。
 */
export function checkPageGuardrails(files: readonly SourceFile[]): GuardrailViolation[] {
  const knownFiles = new Set(files.map(file => file.path))
  const publicApiExports = buildPublicApiExports(files)
  const violations: GuardrailViolation[] = []

  for (const file of files) {
    if (!isPageFile(file.path)) continue
    const pageDomain = pageDomainOf(file.path)
    const sourceFile = parseSourceFile(file)

    for (const reference of collectImportReferences(file.source, file.path)) {
      if (reference.typeOnly) continue
      const resolved = resolveImport(reference.specifier, file.path, knownFiles)

      if (importsPageInfrastructure(reference.specifier, resolved)) {
        violations.push({
          rule: 'page-transport',
          file: file.path,
          message: `页面不得直接依赖传输层或 Query 基础设施（${reference.specifier}）；读取/写入交给领域容器与领域 Query`,
        })
        continue
      }

      if (pageDomain && resolved?.startsWith(`features/${pageDomain}/api/`)) {
        violations.push({
          rule: 'page-transport',
          file: file.path,
          message: `页面不得直接导入本域 API（${reference.specifier}）；读取/写入交给领域容器与领域查询`,
        })
      }
    }

    for (const usage of collectDynamicImportUsages(sourceFile)) {
      const resolved = resolveImport(usage.specifier, file.path, knownFiles)
      const domain = resolved ? isFeatureIndex(resolved)?.domain : null
      const apiNames = domain ? publicApiExports.get(domain) : undefined
      if (!domain || !apiNames?.size) continue

      const endpoints = [...usage.usedNames].filter(name => apiNames.has(name))
      if (endpoints.length === 0) continue
      violations.push({
        rule: 'page-transport',
        file: file.path,
        message: `页面不得动态 import 领域公开面并调用端点 ${domain}.${endpoints.join(', ')}（${usage.specifier}）；请在领域容器中使用所需 hook/组件`,
      })
    }

    for (const binding of collectImportBindings(file.source, file.path)) {
      if (binding.typeOnly) continue
      const resolved = resolveImport(binding.specifier, file.path, knownFiles)
      const domain = resolved ? isFeatureIndex(resolved)?.domain : null
      const apiNames = domain ? publicApiExports.get(domain) : undefined
      if (!domain || !apiNames?.size) continue

      if (binding.imported === '*') {
        const usedNames = collectPropertyUsage(sourceFile, binding.localName)
        const endpoints = [...usedNames].filter(name => apiNames.has(name))
        if (endpoints.length === 0) continue
        violations.push({
          rule: 'page-transport',
          file: file.path,
          message: `页面不得经公开面调用领域端点 ${domain}.${endpoints.join(', ')}（${binding.specifier}）；请交给领域容器/hook`,
        })
      } else if (apiNames.has(binding.imported)) {
        violations.push({
          rule: 'page-transport',
          file: file.path,
          message: `页面不得经公开面直接调用领域端点 ${domain}.${binding.imported}（${binding.specifier}）；请交给领域容器/hook`,
        })
      }
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

export interface DomainSizeTotals {
  pages: number
  /** hooks + model + components 的总行数；不含 api/store/utils 等其他目录。 */
  nonPage: number
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
  /** 按功能域聚合 pages 与 hooks/model/components，用于识别“页面搬进新目录”。 */
  domainTotals: Record<string, DomainSizeTotals>
}

export interface SizeBaseline {
  thresholds: Record<SizeCategory, number>
  largeFiles: Record<SizeCategory, string[]>
  /** 基线时各 feature 的 pages 总行数；旧版预算可缺失，此时跳过搬移检查。 */
  pageLines?: Record<string, number>
  /** 基线时各 feature 的 hooks/model/components 总行数。 */
  nonPageLines?: Record<string, number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验 size-budget.json；旧版预算允许缺少 pageLines/nonPageLines。 */
export function isSizeBaseline(value: unknown): value is SizeBaseline {
  if (!isRecord(value) || !isRecord(value.thresholds) || !isRecord(value.largeFiles)) {
    return false
  }

  for (const category of SIZE_CATEGORIES) {
    const threshold = value.thresholds[category]
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return false
    const files = value.largeFiles[category]
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) return false
  }

  for (const lines of [value.pageLines, value.nonPageLines]) {
    if (lines === undefined) continue
    if (
      !isRecord(lines)
      || Object.values(lines).some(lineCount => typeof lineCount !== 'number' || !Number.isFinite(lineCount))
    ) {
      return false
    }
  }

  return true
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
  if (PAGE_FILE_PATTERN.test(filePath)) return 'pages'
  const match = SIZE_CATEGORY_PATTERN.exec(filePath)
  const category = match?.[1]
  return category === 'hooks' || category === 'model' || category === 'components'
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

  const domainTotals: Record<string, DomainSizeTotals> = {}
  for (const entry of entries) {
    const domain = /^(?:features|pages)\/([^/]+)\//.exec(entry.path)?.[1]
    if (!domain) continue
    const totals = domainTotals[domain] ?? { pages: 0, nonPage: 0 }
    if (entry.category === 'pages') {
      totals.pages += entry.lines
    } else {
      totals.nonPage += entry.lines
    }
    domainTotals[domain] = totals
  }

  return {
    categories,
    totalLines: entries.reduce((sum, entry) => sum + entry.lines, 0),
    totalFiles: entries.length,
    entries,
    domainTotals,
  }
}

/** 同一功能域 pages 缩减到这个行数以上才参与搬移判断，避免小修误报。 */
export const RELOCATION_MIN_SHRINK_LINES = 40
/** 非页面目录增长达到页面缩减量的这个比例时，视为疑似搬移。 */
export const RELOCATION_GROWTH_RATIO = 0.8

/**
 * 规模预算冻结「超过阈值的大文件集合」，并检查页面逻辑是否被整体搬进同域
 * 的非页面目录：
 * - 新增一个超过本类阈值、且不在基线中的文件 → 失败；
 * - 同一 feature 的 pages 缩减 ≥ 40 行，且 hooks/model/components 增长达到
 *   缩减量的 80% 以上 → 判为疑似搬移并失败；
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

  for (const [domain, totals] of Object.entries(report.domainTotals).sort(([a], [b]) => a.localeCompare(b))) {
    const baselinePages = baseline.pageLines?.[domain]
    const baselineNonPage = baseline.nonPageLines?.[domain]
    if (baselinePages === undefined || baselineNonPage === undefined) continue

    const shrink = baselinePages - totals.pages
    if (shrink < RELOCATION_MIN_SHRINK_LINES) continue

    const growth = totals.nonPage - baselineNonPage
    if (growth < Math.ceil(shrink * RELOCATION_GROWTH_RATIO)) continue

    violations.push(
      `疑似把页面逻辑搬进非页面目录：pages/${domain} 从 ${baselinePages} 行降到 ${totals.pages} 行`
      + `（-${shrink}），hooks/model/components 从 ${baselineNonPage} 行增到 ${totals.nonPage} 行（+${growth}）。`
      + '请确认是真实拆分；如属有意的结构调整，运行 guardrails:size-baseline 并说明依据。',
    )
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
