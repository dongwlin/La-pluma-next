#!/usr/bin/env node
// stylelint ratchet（预算制）：冻结存量违规数为基线，只拦净新增。
//
// - 基线文件 client/stylelint-baseline.json 按文件粒度记录（文件 -> 规则 -> 违规数），
//   文件移动/改名时比单一总数更稳（Phase 1 计划把 index.css/ios-theme.css 迁入 src/styles/）。
// - 存量违规在 .stylelintrc.json 里是 warning，不阻塞本地开发；本脚本负责拦净新增。
// - 当前违规数 <= 基线则通过；超出则失败并指出哪个文件新增了什么。
// - 基线需要更新（有意重构/迁移后）时：node scripts/stylelint-ratchet.ts --update-baseline
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import stylelint from 'stylelint'
import type { Warning } from 'stylelint'

interface StylelintBaseline {
  _comment: string
  _total?: number
  files?: Record<string, Record<string, number>>
}

interface FileViolations {
  byRule: Record<string, number>
  warnings: Warning[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(clientRoot, 'stylelint-baseline.json')
const GLOB = 'src/**/*.css'

const updateBaseline = process.argv.includes('--update-baseline')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const { results } = await stylelint.lint({
  cwd: clientRoot,
  files: GLOB,
  formatter: 'json',
})

// 按文件粒度聚合：相对路径 -> { 规则名 -> 数量 }
const current = new Map<string, FileViolations>()
let total = 0
for (const file of results) {
  total += file.warnings.length
  if (file.warnings.length === 0 || !file.source) continue

  const rel = path.relative(clientRoot, file.source).replaceAll('\\', '/')
  const byRule: Record<string, number> = {}
  for (const warning of file.warnings) {
    byRule[warning.rule] = (byRule[warning.rule] ?? 0) + 1
  }
  current.set(rel, { byRule, warnings: file.warnings })
}

if (updateBaseline) {
  const baseline: StylelintBaseline = {
    _comment:
      'stylelint ratchet 基线：按文件记录存量违规数（文件 -> 规则 -> 数量）。禁止手工放宽，仅可通过 `pnpm --filter la-pluma-next-client stylelint:baseline` 在违规数下降或有意的重构后重新生成。',
    _total: total,
    files: Object.fromEntries(
      [...current.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, { byRule }]) => [file, byRule]),
    ),
  }
  await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`基线已更新：共 ${total} 条存量违规，覆盖 ${current.size} 个文件。`)
  process.exit(0)
}

const baseline: StylelintBaseline = await readFile(BASELINE_PATH, 'utf8')
  .then((raw) => JSON.parse(raw) as StylelintBaseline)
  .catch((error: unknown) => {
    console.error(`无法读取基线文件 ${BASELINE_PATH}：${errorMessage(error)}`)
    console.error('如为首次生成，请运行：pnpm --filter la-pluma-next-client stylelint:baseline')
    process.exit(2)
  })

const baselineFiles = baseline.files ?? {}
let failed = false
const notes: string[] = []

// 1) 新文件出现违规（基线里没有这个文件）。
for (const [file, { byRule, warnings }] of current) {
  const base = baselineFiles[file]
  if (!base) {
    failed = true
    notes.push(`新增违规文件：${file}（基线中不存在，共 ${Object.values(byRule).reduce((a, b) => a + b, 0)} 条）`)
    notes.push(...locations(warnings))
    continue
  }
  for (const [rule, count] of Object.entries(byRule)) {
    const allowed = base[rule] ?? 0
    if (count > allowed) {
      failed = true
      notes.push(`净新增违规：${file} · ${rule}（基线 ${allowed} -> 当前 ${count}，新增 ${count - allowed}）`)
      notes.push(...locations(warnings.filter((w) => w.rule === rule)))
    }
  }
}

// 2) 基线里存在、但当前已不存在的文件（迁移/删除后基线过期，提示更新但不阻塞）。
for (const file of Object.keys(baselineFiles)) {
  if (!current.has(file)) {
    notes.push(`提示：基线中的 ${file} 已不在 ${GLOB} 范围内，可用 --update-baseline 清理基线。`)
  }
}

if (failed) {
  console.error(`stylelint ratchet 失败：违规数超出基线（当前 ${total} 条）。`)
  console.error('新样式不得新增违规；如属有意重构/迁移，请修正后在本地重新生成基线并说明：')
  console.error('')
  console.error(notes.join('\n'))
  process.exit(1)
}

console.log(`stylelint ratchet 通过：${total} 条存量违规，未超出基线（${current.size} 个文件）。`)
for (const note of notes) console.log(note)
if (baseline._total !== undefined && total < baseline._total) {
  console.log(`提示：违规数已低于基线（${total} < ${baseline._total}），可用 --update-baseline 收紧基线。`)
}

function locations(warnings: Warning[]): string[] {
  return warnings.map((w) => `  ${w.line}:${w.column}  ${w.text.split(' (')[0]}`)
}
