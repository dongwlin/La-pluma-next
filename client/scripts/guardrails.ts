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

export interface ImportBinding {
  specifier: string
  /** 具名导入使用导出名；默认/命名空间导入分别为 `default` / `*`。 */
  imported: string
  typeOnly: boolean
}

export interface ImportReference {
  specifier: string
  /** 整条 import/export 都是类型时跳过页面运行时检查。 */
  typeOnly: boolean
  dynamic: boolean
}

export interface ReExport {
  exportedName: string
  specifier: string
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
 * 同时保留“整条导入只是类型”与“是否动态”的信息，供页面职责检查使用。
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
        dynamic: false,
      })
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyExportDeclaration(node),
        dynamic: false,
      })
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArgument] = node.arguments
      if (firstArgument && ts.isStringLiteralLike(firstArgument)) {
        references.push({ specifier: firstArgument.text, typeOnly: false, dynamic: true })
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
      bindings.push({ specifier, imported: 'default', typeOnly: declarationTypeOnly })
    }

    const namedBindings = clause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.push({ specifier, imported: '*', typeOnly: declarationTypeOnly })
      continue
    }

    for (const element of namedBindings.elements) {
      bindings.push({
        specifier,
        imported: element.propertyName?.text ?? element.name.text,
        typeOnly: declarationTypeOnly || element.isTypeOnly,
      })
    }
  }

  return bindings
}

/** 取出公开面 `export { ... } from './module'` 与 `export * from './module'` 的来源。 */
export function collectReExports(source: string, filePath = 'sample.ts'): ReExport[] {
  const sourceFile = parseSourceFile({ path: filePath, source })
  const reExports: ReExport[] = []

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue
    }

    const specifier = statement.moduleSpecifier.text
    if (!statement.exportClause) {
      reExports.push({ exportedName: '*', specifier, typeOnly: statement.isTypeOnly })
      continue
    }

    if (ts.isNamespaceExport(statement.exportClause)) {
      reExports.push({
        exportedName: statement.exportClause.name.text,
        specifier,
        typeOnly: statement.isTypeOnly,
      })
      continue
    }

    if (!ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      reExports.push({
        exportedName: element.name.text,
        specifier,
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
    || (ts.isImportClause(parent) && parent.name === node)
    || (ts.isImportSpecifier(parent) && parent.name === node)
    || (ts.isNamespaceImport(parent) && parent.name === node)
    || (ts.isImportEqualsDeclaration(parent) && parent.name === node)
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
    if (
      ts.isIdentifier(node)
      && !isPropertyName(node)
      && !isBindingName(node)
      && pageRuleForGlobal(node.text)
    ) {
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

    if (
      ts.isElementAccessExpression(node)
      && isGlobalObjectExpression(node.expression)
      && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)
      && pageRuleForGlobal(node.argumentExpression.text)
    ) {
      report(
        node.argumentExpression.text,
        sourceFile.getLineAndCharacterOfPosition(node.argumentExpression.getStart()).line + 1,
      )
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
 * 收集各 feature 公开面中来自 `api/` 的导出名。
 *
 * 只禁 `@/features/x/api` 深路径不足以阻止页面直接调用端点：公开面可以把
 * `executeScheduleNow`、`saveUserConfig` 等端点再导出，也可能使用
 * `export * from './api'`。页面检查沿公开面定位来源，仍允许同一条公开面
 * 导出的领域 hook/组件。
 */
function buildPublicApiExports(files: readonly SourceFile[]): Map<string, Set<string>> {
  const filesByPath = new Map(files.map(file => [file.path, file]))
  const knownFiles = new Set(filesByPath.keys())
  const apiExports = new Map<string, Set<string>>()

  for (const file of files) {
    const domain = /^features\/([^/]+)\/index\.tsx?$/.exec(file.path)?.[1]
    if (!domain) continue

    for (const reExport of collectReExports(file.source, file.path)) {
      if (reExport.typeOnly) continue
      const target = resolveImport(reExport.specifier, file.path, knownFiles)
      if (!target?.startsWith(`features/${domain}/api/`)) continue

      let names = apiExports.get(domain)
      if (!names) {
        names = new Set()
        apiExports.set(domain, names)
      }

      if (reExport.exportedName === '*') {
        for (const name of collectModuleExportedNames(target, filesByPath, knownFiles, new Set())) {
          names.add(name)
        }
      } else {
        names.add(reExport.exportedName)
      }
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
    const pageDomain = featureDomainOf(file.path)

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
        continue
      }

      if (!reference.dynamic) continue
      const domain = /^@\/features\/([^/]+)$/.exec(reference.specifier)?.[1]
      if (!domain || !publicApiExports.get(domain)?.size) continue
      violations.push({
        rule: 'page-transport',
        file: file.path,
        message: `页面不得动态 import 含领域端点的公开面（${reference.specifier}）；请在领域容器中静态使用所需 hook/组件`,
      })
    }

    for (const binding of collectImportBindings(file.source, file.path)) {
      if (binding.typeOnly) continue
      const domain = /^@\/features\/([^/]+)$/.exec(binding.specifier)?.[1]
      const apiNames = domain ? publicApiExports.get(domain) : undefined
      if (!domain || !apiNames) continue

      if (binding.imported === '*') {
        violations.push({
          rule: 'page-transport',
          file: file.path,
          message: `页面不得整体导入 ${binding.specifier}；请只导入所需领域 hook/组件，端点调用归领域容器`,
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
  /** 基线时各 feature 的 pages 总行数，用于搬移启发式。 */
  pageLines: Record<string, number>
  /** 基线时各 feature 的 hooks/model/components 总行数。 */
  nonPageLines: Record<string, number>
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

  const domainTotals: Record<string, DomainSizeTotals> = {}
  for (const entry of entries) {
    const domain = /^features\/([^/]+)\//.exec(entry.path)?.[1]
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
    const baselinePages = baseline.pageLines[domain]
    const baselineNonPage = baseline.nonPageLines[domain]
    if (baselinePages === undefined || baselineNonPage === undefined) continue

    const shrink = baselinePages - totals.pages
    if (shrink < RELOCATION_MIN_SHRINK_LINES) continue

    const growth = totals.nonPage - baselineNonPage
    if (growth < Math.ceil(shrink * RELOCATION_GROWTH_RATIO)) continue

    violations.push(
      `疑似把页面逻辑搬进非页面目录：features/${domain} 的 pages 从 ${baselinePages} 行降到 ${totals.pages} 行`
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
