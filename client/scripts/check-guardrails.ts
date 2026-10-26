#!/usr/bin/env node
// 依赖与职责护栏 CLI。
//
// 阻断项：
// - 功能域依赖环、深路径/公开面绕过、shared/feature 反向分层依赖；
// - task-execution 反向依赖其他功能域；
// - 页面文件直接持有传输、存储或轮询原语。
//
// 辅助项：
// - 输出 hooks/model/components/pages 的规模观察；
// - 用 size-budget.json 冻结「超阈值大文件集合」，新增超阈值文件时失败。
//   阈值依据迁移结果与分类分布，见 docs/guardrails.md；正常的小幅增长
//   不需要更新基线，确实需要新增一个大文件时运行：
//   pnpm --filter la-pluma-next-client guardrails:size-baseline
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SIZE_THRESHOLDS,
  SIZE_CATEGORIES,
  analyzeDependencies,
  analyzeSize,
  checkPageGuardrails,
  evaluateSizeBudget,
  readSourceTree,
  type GuardrailRule,
  type GuardrailViolation,
  type SizeBaseline,
  type SizeCategory,
  type SizeReport,
} from './guardrails.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(clientRoot, 'src')
const BUDGET_PATH = path.join(clientRoot, 'size-budget.json')

const updateSizeBaseline = process.argv.includes('--update-size-baseline')

const BUDGET_COMMENT =
  '规模预算：按分类冻结超过阈值的文件集合。阈值依据 FPR-031–040/044 迁移后的生产源码分布（p90 向上取整到 20 行），见 docs/guardrails.md。正常增长不更新基线；有意新增/拆分大文件时运行 pnpm --filter la-pluma-next-client guardrails:size-baseline。'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSizeBaseline(value: unknown): value is SizeBaseline {
  if (!isRecord(value) || !isRecord(value.thresholds) || !isRecord(value.largeFiles)) {
    return false
  }

  for (const category of SIZE_CATEGORIES) {
    const threshold = value.thresholds[category]
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return false
    const files = value.largeFiles[category]
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) return false
  }

  return true
}

async function readSizeBaselineFile(): Promise<SizeBaseline | null> {
  let raw: string
  try {
    raw = await readFile(BUDGET_PATH, 'utf8')
  } catch (error: unknown) {
    const code = isRecord(error) ? error.code : undefined
    if (code === 'ENOENT') return null
    console.error(`无法读取规模预算 ${BUDGET_PATH}：${errorMessage(error)}`)
    process.exit(2)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    console.error(`规模预算不是合法 JSON：${errorMessage(error)}`)
    process.exit(2)
  }

  if (!isSizeBaseline(parsed)) {
    console.error('规模预算结构无效：需要 thresholds 与 largeFiles（按分类列出文件路径）。')
    process.exit(2)
  }

  return parsed
}

async function loadSizeBaseline(): Promise<SizeBaseline> {
  const baseline = await readSizeBaselineFile()
  if (!baseline) {
    console.error(`无法读取规模预算 ${BUDGET_PATH}：文件不存在。`)
    console.error('如为首次生成，请运行：pnpm --filter la-pluma-next-client guardrails:size-baseline')
    process.exit(2)
  }
  return baseline
}

function printViolations(violations: readonly GuardrailViolation[]): void {
  for (const violation of violations) {
    console.error(`[${violation.rule}] ${violation.file}`)
    console.error(`  ${violation.message}`)
  }
}

function printSizeReport(report: SizeReport): void {
  console.log('规模观察（按目录分类，测试文件不计；总行数仅报告，不单独判失败）：')
  for (const category of report.categories) {
    console.log(
      `  ${category.category.padEnd(10)}`
      + `${String(category.fileCount).padStart(3)} 文件 `
      + `${String(category.totalLines).padStart(6)} 行  `
      + `中位 ${String(category.medianLines).padStart(4)}  `
      + `阈值 ${String(category.threshold).padStart(4)}  `
      + `超阈值 ${category.largeFiles.length}`,
    )
  }
  console.log(
    `  合计       ${String(report.totalFiles).padStart(3)} 文件 ${String(report.totalLines).padStart(6)} 行`,
  )

  const largeFiles = report.categories.flatMap(category => category.largeFiles)
  if (largeFiles.length > 0) {
    console.log('超阈值文件（预算内的存量项；新增项会失败）：')
    for (const entry of largeFiles) {
      console.log(`  ${entry.category.padEnd(10)} ${String(entry.lines).padStart(5)} 行  ${entry.path}`)
    }
  }
}

function printRuleSummary(violations: readonly GuardrailViolation[]): void {
  const rules: GuardrailRule[] = [
    'domain-cycle',
    'deep-import',
    'layer-direction',
    'task-execution-reverse',
    'page-transport',
    'page-storage',
    'page-polling',
  ]
  for (const rule of rules) {
    const count = violations.filter(violation => violation.rule === rule).length
    console.log(`  ${rule.padEnd(22)} ${count}`)
  }
}

const sourceFiles = await readSourceTree(srcRoot)
const dependencyAnalysis = analyzeDependencies(sourceFiles)
const pageViolations = checkPageGuardrails(sourceFiles)
const violations = [...dependencyAnalysis.violations, ...pageViolations]

const featureDomains = new Set(
  dependencyAnalysis.edges.flatMap((edge) => {
    const [top, domain] = edge.from.split('/')
    return top === 'features' && domain ? [domain] : []
  }),
)

console.log(
  `依赖与职责护栏：扫描 ${sourceFiles.length} 个源文件、${dependencyAnalysis.edges.length} 条源码内 import；`
  + `${featureDomains.size} 个功能域，${dependencyAnalysis.cycles.length} 个依赖环。`,
)
if (violations.length > 0) {
  console.error(`发现 ${violations.length} 项违规：`)
  printViolations(violations)
  console.error('')
  printRuleSummary(violations)
  console.error('')
  console.error('规则说明见 docs/guardrails.md。')
  process.exit(1)
}
console.log('依赖与职责检查通过（域环、深路径、分层方向、task-execution 反向依赖、页面裸副作用）。')

let thresholds: Record<SizeCategory, number>
if (updateSizeBaseline) {
  const existing = await readSizeBaselineFile()
  thresholds = existing?.thresholds ?? DEFAULT_SIZE_THRESHOLDS
  const report = analyzeSize(sourceFiles, thresholds)
  const largeFiles = Object.fromEntries(
    report.categories.map(category => [
      category.category,
      category.largeFiles.map(entry => entry.path).sort((a, b) => a.localeCompare(b)),
    ]),
  ) as Record<SizeCategory, string[]>

  const baseline = {
    _comment: BUDGET_COMMENT,
    thresholds,
    largeFiles,
  } satisfies SizeBaseline & { _comment: string }

  await writeFile(BUDGET_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`规模预算已更新：${BUDGET_PATH}`)
  printSizeReport(report)
  process.exit(0)
}

const baseline = await loadSizeBaseline()
thresholds = baseline.thresholds
const report = analyzeSize(sourceFiles, thresholds)
printSizeReport(report)

const budgetResult = evaluateSizeBudget(report, baseline)
if (budgetResult.notes.length > 0) {
  console.log('规模预算提示：')
  for (const note of budgetResult.notes) {
    console.log(`  ${note}`)
  }
}

if (budgetResult.violations.length > 0) {
  console.error(`规模预算失败：${budgetResult.violations.length} 个新增超阈值文件。`)
  for (const violation of budgetResult.violations) {
    console.error(`  ${violation}`)
  }
  console.error('如确属真实拆分需求，先确认不是把同量逻辑搬到另一个目录，再运行：')
  console.error('  pnpm --filter la-pluma-next-client guardrails:size-baseline')
  process.exit(1)
}

console.log('规模预算通过：未新增超阈值文件。')
