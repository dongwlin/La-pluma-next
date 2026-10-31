/**
 * 服务端类型与职责护栏的分析核心。
 *
 * 只做静态事实判断，不运行服务端、不启动子进程：
 * - 类型逃生舱：显式 `any`、TypeScript 抑制指令（`@ts-` 系列注释）、经
 *   `any` / `unknown` 的双重断言；
 * - 分层方向：`utils` / `config` → `services` → `controllers` → `routes` →
 *   `app.ts` / `server.ts` 单向，`scripts/` 只作为工具入口，生产模块不得反向依赖它；
 * - 静态导入环：静态 `import` / `export ... from` 形成的环（动态 `import()` 是
 *   有意的延迟加载断环手段，不在本检查范围，见 docs）；
 * - 未归层文件：新增顶层模块或目录必须先归入既有层，避免无声绕过依赖检查。
 *
 * 测试与 fixture（`__tests__/` 下）不进入分层与依赖环分析，但仍检查类型逃生舱：
 * 测试可以为了构造状态而接触内部实现，不能因此放宽生产代码的类型边界。
 *
 * 存量例外只允许登记在 `guardrails-baseline.json`：按规则与文件记录数量、理由和
 * 移除条件。新文件或超出登记数量的违规直接失败；违规数下降后应同步下调基线。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { collectFiles, relativePath } from './sourceFiles.ts';

export interface SourceFile {
  /** 相对 server 根目录的 POSIX 路径，例如 `routes/agent.ts`。 */
  path: string;
  source: string;
}

export type GuardrailRule =
  | 'explicit-any'
  | 'suppression-directive'
  | 'double-assertion'
  | 'layer-inversion'
  | 'import-cycle'
  | 'unlayered-file';

export interface GuardrailViolation {
  rule: GuardrailRule;
  file: string;
  line: number;
  message: string;
}

export interface BaselineEntry {
  rule: GuardrailRule;
  file: string;
  count: number;
  /** 为什么暂时保留；必须说明当前无法消除的具体原因。 */
  reason: string;
  /** 移除条件：满足后删除该条目与对应违规。 */
  remove: string;
}

export interface GuardrailsBaseline {
  version: number;
  entries: BaselineEntry[];
}

export interface BaselineFailure {
  rule: GuardrailRule;
  file: string;
  actual: number;
  allowed: number;
  lines: number[];
}

export interface BaselineReduction {
  rule: GuardrailRule;
  file: string;
  actual: number;
  allowed: number;
}

export interface BaselineResult {
  failures: BaselineFailure[];
  reductions: BaselineReduction[];
}

export const GUARDRAIL_RULES: readonly GuardrailRule[] = [
  'explicit-any',
  'suppression-directive',
  'double-assertion',
  'layer-inversion',
  'import-cycle',
  'unlayered-file'
];

type Layer = 'utils' | 'config' | 'services' | 'controllers' | 'routes' | 'scripts' | 'entry';

const LAYER_DIRECTORIES: ReadonlyArray<readonly [string, Layer]> = [
  ['utils/', 'utils'],
  ['config/', 'config'],
  ['services/', 'services'],
  ['controllers/', 'controllers'],
  ['routes/', 'routes'],
  ['scripts/', 'scripts']
];

/**
 * 每层允许依赖的目标层。方向只向下：上层可以用下层，下层不能反向依赖上层。
 * `scripts` 是维护工具入口，可以调用业务代码，但业务代码不能依赖脚本。
 */
const ALLOWED_IMPORT_TARGETS: Record<Layer, readonly Layer[]> = {
  utils: ['utils', 'config'],
  config: ['config', 'utils'],
  services: ['utils', 'config', 'services'],
  controllers: ['utils', 'config', 'services', 'controllers'],
  routes: ['utils', 'config', 'services', 'controllers', 'routes'],
  entry: ['utils', 'config', 'services', 'routes', 'scripts', 'entry'],
  scripts: ['utils', 'config', 'services', 'routes', 'scripts']
};

const SUPPRESSION_DIRECTIVE_PATTERN = /@ts-(?:ignore|nocheck|expect-error)\b/;

/** 测试与 fixture 目录不参与分层与依赖环分析。 */
export function isTestFile(filePath: string): boolean {
  return /(?:^|\/)__tests__\//.test(filePath);
}

/** 顶层入口模块：`app.ts` 只做应用装配，`server.ts` 负责传输与启动。 */
const ENTRY_MODULES: ReadonlySet<string> = new Set(['app.ts', 'server.ts']);

/** 返回文件所属层；顶层入口只允许 `app.ts` 与 `server.ts`。 */
export function layerOf(filePath: string): Layer | undefined {
  if (ENTRY_MODULES.has(filePath)) return 'entry';
  for (const [prefix, layer] of LAYER_DIRECTORIES) {
    if (filePath.startsWith(prefix)) return layer;
  }
  return undefined;
}

/** 读取服务端全部 TypeScript 源；范围与类型门禁一致。 */
export function collectServerSources(rootDir: string): SourceFile[] {
  return collectFiles(rootDir, ['.ts'])
    .map(filePath => ({
      path: relativePath(rootDir, filePath),
      source: readFileSync(filePath, 'utf8')
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function pushViolation(
  violations: GuardrailViolation[],
  sourceFile: ts.SourceFile,
  rule: GuardrailRule,
  filePath: string,
  position: number,
  message: string
): void {
  violations.push({ rule, file: filePath, line: lineOf(sourceFile, position), message });
}

function isAssertionExpression(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** 显式 any、抑制指令与经 any/unknown 的双重断言。 */
function collectTypeEscapes(sourceFile: SourceFile, parsed: ts.SourceFile, violations: GuardrailViolation[]): void {
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      pushViolation(
        violations,
        parsed,
        'explicit-any',
        sourceFile.path,
        node.getStart(parsed),
        '显式 any 绕过类型边界；应从 unknown 开始做运行时收窄或使用具体类型'
      );
    }

    if (isAssertionExpression(node)) {
      const inner = unwrapParentheses(node.expression);
      if (isAssertionExpression(inner) && (inner.type.kind === ts.SyntaxKind.AnyKeyword || inner.type.kind === ts.SyntaxKind.UnknownKeyword)) {
        pushViolation(
          violations,
          parsed,
          'double-assertion',
          sourceFile.path,
          node.getStart(parsed),
          '经 any/unknown 的双重断言关闭了编译器检查；改用运行时校验或类型守卫'
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceFile.source);
  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    if (!SUPPRESSION_DIRECTIVE_PATTERN.test(scanner.getTokenText())) continue;
    pushViolation(
      violations,
      parsed,
      'suppression-directive',
      sourceFile.path,
      scanner.getTokenPos(),
      '@ts-ignore / @ts-nocheck / @ts-expect-error 隐藏类型错误；应修正类型或登记具名例外'
    );
  }
}

export interface ImportEdge {
  from: string;
  to: string;
  line: number;
}

function resolveRelativeImport(fromPath: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (knownFiles.has(resolved)) return resolved;
  const index = path.posix.join(resolved, 'index.ts');
  return knownFiles.has(index) ? index : undefined;
}

/** 静态 import / export ... from 产生的本地模块边；动态 import() 不在此列。 */
function collectStaticImports(
  sourceFile: SourceFile,
  parsed: ts.SourceFile,
  knownFiles: ReadonlySet<string>
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const target = resolveRelativeImport(sourceFile.path, specifier.text, knownFiles);
    if (!target) continue;
    edges.push({ from: sourceFile.path, to: target, line: lineOf(parsed, specifier.getStart(parsed)) });
  }
  return edges;
}

/** 求静态导入图的强连通分量；只返回包含多个模块的分量。 */
export function findImportCycles(edges: readonly ImportEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next);
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() ?? '';
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) components.push(component.sort());
  };

  for (const node of adjacency.keys()) {
    if (!indices.has(node)) connect(node);
  }

  return components;
}

/** 分析一组源码，返回全部规则命中的原始违规（尚未应用基线）。 */
export function analyzeSources(files: readonly SourceFile[]): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const parsedFiles = new Map<string, ts.SourceFile>();
  const knownFiles = new Set(files.map(file => file.path));

  for (const file of files) {
    const parsed = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsedFiles.set(file.path, parsed);
    collectTypeEscapes(file, parsed, violations);
  }

  const productionFiles = files.filter(file => !isTestFile(file.path));
  const edges: ImportEdge[] = [];
  for (const file of productionFiles) {
    const parsed = parsedFiles.get(file.path);
    if (!parsed) continue;

    const layer = layerOf(file.path);
    if (!layer) {
      pushViolation(
        violations,
        parsed,
        'unlayered-file',
        file.path,
        1,
        '文件未归入 utils/config/services/controllers/routes/scripts 或 app.ts/server.ts 入口；先确定所属层再新增模块'
      );
    }

    for (const edge of collectStaticImports(file, parsed, knownFiles)) {
      edges.push(edge);
      if (!layer) continue;
      const targetLayer = layerOf(edge.to);
      if (!targetLayer) continue;
      const allowed = ALLOWED_IMPORT_TARGETS[layer];
      if (allowed.includes(targetLayer)) continue;
      violations.push({
        rule: 'layer-inversion',
        file: edge.from,
        line: edge.line,
        message: `${layer} 不得依赖 ${targetLayer}（${edge.to}）；只允许 ${allowed.join(' / ')}`
      });
    }
  }

  for (const component of findImportCycles(edges)) {
    const members = new Set(component);
    const closingEdge = edges.find(edge => edge.from === component[0] && members.has(edge.to))
      ?? edges.find(edge => members.has(edge.from) && members.has(edge.to));
    violations.push({
      rule: 'import-cycle',
      file: component[0],
      line: closingEdge?.line ?? 1,
      message: `静态导入环：${component.join(' → ')}`
    });
  }

  return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验基线文件结构；未知规则、重复条目或缺少理由/移除条件都直接报错。 */
export function parseBaseline(value: unknown): GuardrailsBaseline {
  if (!isRecord(value)) throw new Error('guardrails baseline 必须是对象');
  if (value.version !== 1) throw new Error('guardrails baseline 的 version 必须为 1');
  if (!Array.isArray(value.entries)) throw new Error('guardrails baseline 的 entries 必须是数组');

  const seen = new Set<string>();
  const entries = value.entries.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`guardrails baseline entries[${index}] 必须是对象`);
    const { rule, file, count, reason, remove } = raw;
    if (typeof rule !== 'string' || !GUARDRAIL_RULES.includes(rule as GuardrailRule)) {
      throw new Error(`guardrails baseline entries[${index}] 的 rule 未知: ${String(rule)}`);
    }
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error(`guardrails baseline entries[${index}] 缺少 file`);
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new Error(`guardrails baseline entries[${index}] 的 count 必须是正整数`);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(`guardrails baseline entries[${index}] 缺少 reason`);
    }
    if (typeof remove !== 'string' || remove.trim().length === 0) {
      throw new Error(`guardrails baseline entries[${index}] 缺少 remove（移除条件）`);
    }
    const key = `${rule}\u0000${file}`;
    if (seen.has(key)) throw new Error(`guardrails baseline 重复登记 ${rule} / ${file}`);
    seen.add(key);
    return { rule: rule as GuardrailRule, file, count, reason, remove };
  });

  return { version: 1, entries };
}

function baselineKey(rule: GuardrailRule, file: string): string {
  return `${rule}\u0000${file}`;
}

/** 用基线解释存量违规：超出登记数量失败，低于登记数量提示下调。 */
export function applyBaseline(
  violations: readonly GuardrailViolation[],
  baseline: GuardrailsBaseline
): BaselineResult {
  const grouped = new Map<string, GuardrailViolation[]>();
  for (const violation of violations) {
    const key = baselineKey(violation.rule, violation.file);
    const group = grouped.get(key) ?? [];
    group.push(violation);
    grouped.set(key, group);
  }

  const failures: BaselineFailure[] = [];
  for (const [key, group] of grouped) {
    const [rule, file] = key.split('\u0000') as [GuardrailRule, string];
    const allowed = baseline.entries.find(entry => baselineKey(entry.rule, entry.file) === key)?.count ?? 0;
    if (group.length <= allowed) continue;
    failures.push({
      rule,
      file,
      actual: group.length,
      allowed,
      lines: group.map(violation => violation.line).sort((left, right) => left - right)
    });
  }

  const reductions: BaselineReduction[] = [];
  for (const entry of baseline.entries) {
    const actual = grouped.get(baselineKey(entry.rule, entry.file))?.length ?? 0;
    if (actual < entry.count) {
      reductions.push({ rule: entry.rule, file: entry.file, actual, allowed: entry.count });
    }
  }

  return { failures, reductions };
}
