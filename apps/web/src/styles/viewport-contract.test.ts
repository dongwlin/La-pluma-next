import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE_ROOT = join(WEB_ROOT, 'src')
const INDEX_HTML = join(WEB_ROOT, 'index.html')

const VIEWPORT_META_RE = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/gi
const VIEWPORT_CONTENT_RE = /\bcontent=["']([^"']*)["']/i
const BOOT_STYLE_RE = /<style id="la-pluma-boot-style">([\s\S]*?)<\/style>/
const CUSTOM_PROPERTY_RE = /(--[\w-]+)\s*:\s*([^;]+);/g
const DVH_SUPPORT_RE = /@supports\s+not\s*\(\s*height:\s*100dvh\s*\)/i
const VIEWPORT_UNIT_RE = /(?<![\w-])(?:\d+(?:\.\d+)?(?:dvh|svh|lvh|vh)|(?:min-|max-)?[hw]-(?:dvh|svh|lvh))\b/g

const DIALOG_MAX_HEIGHT_CLASS = 'max-h-(--layout-dialog-max-height)'
const SHEET_MAX_HEIGHT_CLASS = 'max-h-(--layout-sheet-max-height)'

const DIALOG_FILES = [
  'src/features/automation/components/InfrastScheduleEditor.tsx',
  'src/features/combat/components/CombatCopilotDiscoveryDialog.tsx',
  'src/features/combat/components/CombatCopilotMatchDialog.tsx',
  'src/features/combat/components/CombatCopilotOperatorFilterDialog.tsx',
  'src/features/training/components/OperatorPicker.tsx',
  'src/features/training/components/OperatorSelectModal.tsx',
]

const BARE_VIEWPORT_UNIT_ALLOWLIST = new Map([
  ['index.html', '启动壳视口高度 token 与 viewport meta'],
  ['src/styles/layout.css', '壳层与弹层视口 token 的唯一来源'],
  ['src/styles/index.css', 'PWA 提示沿用 --layout-viewport-height 的既有 fallback'],
  ['src/styles/ios-theme.css', 'more-sheet 的 78dvh 局部例外'],
  ['src/features/automation/styles/automation.css', '自动化配置面板沿用 --layout-viewport-height 的既有 fallback'],
  ['src/features/logs/styles/logs.css', '日志控制台使用 svh 的页内固定高度'],
  ['src/features/device-mirror/components/ScrcpyDeviceView.tsx', '沉浸设备画面视口由设备画面批次处理'],
  ['src/shared/ui/sidebar.tsx', 'shadcn 生成文件按上游保留'],
])

const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  'coverage',
  'dist',
  'integration-artifacts',
  'node_modules',
  'test-results',
])

interface TokenDeclaration {
  value: string
  index: number
}

function webPath(file: string): string {
  return relative(WEB_ROOT, file).split(sep).join('/')
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    if (IGNORED_DIRECTORIES.has(entry)) return []
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectSourceFiles(path)
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) return []
    return SOURCE_EXTENSIONS.has(extname(path)) ? [path] : []
  })
}

function declarationsOf(source: string, token: string): TokenDeclaration[] {
  return [...source.matchAll(CUSTOM_PROPERTY_RE)].flatMap(match => {
    if (match[1] !== token || match.index === undefined) return []
    return [{
      value: (match[2] ?? '').replace(/\s+/g, ' ').trim(),
      index: match.index,
    }]
  })
}

function blockContents(source: string, startIndex: number): string {
  const open = source.indexOf('{', startIndex)
  if (open === -1) throw new Error(`missing block after index ${startIndex}`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  throw new Error(`unbalanced block after index ${startIndex}`)
}

function readIndexHtml(): string {
  return readFileSync(INDEX_HTML, 'utf8')
}

function readBootStyle(): string {
  const bootStyle = BOOT_STYLE_RE.exec(readIndexHtml())?.[1]
  if (!bootStyle) throw new Error('index.html 缺少启动壳样式块')
  return bootStyle
}

function readSource(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf8')
}

describe('viewport contract', () => {
  it('declares one viewport meta with cover and interactive widget resizing', () => {
    const metas = [...readIndexHtml().matchAll(VIEWPORT_META_RE)]
    expect(metas).toHaveLength(1)

    const content = VIEWPORT_CONTENT_RE.exec(metas[0]?.[0] ?? '')?.[1] ?? ''
    expect(content).toContain('width=device-width')
    expect(content).toContain('viewport-fit=cover')
    expect(content).toContain('interactive-widget=resizes-content')
  })

  it('keeps shell viewport height on dvh, lvh and vh branches', () => {
    const layoutCss = readSource('src/styles/layout.css')
    const bootStyle = readBootStyle()

    const layoutSupportIndex = layoutCss.search(DVH_SUPPORT_RE)
    const standaloneIndex = layoutCss.indexOf('@media (display-mode: standalone)')
    expect(layoutSupportIndex).toBeGreaterThan(-1)
    expect(standaloneIndex).toBeGreaterThan(-1)
    expect(layoutSupportIndex).toBeLessThan(standaloneIndex)

    const bootSupportIndex = bootStyle.search(DVH_SUPPORT_RE)
    const bootStandaloneIndex = bootStyle.indexOf('@media (display-mode: standalone)')
    expect(bootSupportIndex).toBeGreaterThan(-1)
    expect(bootStandaloneIndex).toBeGreaterThan(-1)
    expect(bootSupportIndex).toBeLessThan(bootStandaloneIndex)

    expect(declarationsOf(layoutCss, '--layout-viewport-height').map(({ value }) => value))
      .toEqual(['100dvh', '100vh', '100lvh', '100lvh', '100vh', '100vh'])
    expect(declarationsOf(blockContents(layoutCss, layoutSupportIndex), '--layout-viewport-height')
      .map(({ value }) => value)).toEqual(['100vh'])
    expect(declarationsOf(bootStyle, '--boot-viewport-height').map(({ value }) => value))
      .toEqual(['100dvh', '100vh', '100lvh', '100lvh', '100vh', '100vh'])
    expect(declarationsOf(blockContents(bootStyle, bootSupportIndex), '--boot-viewport-height')
      .map(({ value }) => value)).toEqual(['100vh'])
  })

  it('defines dialog and sheet max heights with vh fallbacks', () => {
    const layoutCss = readSource('src/styles/layout.css')
    const supportIndex = layoutCss.search(DVH_SUPPORT_RE)
    expect(supportIndex).toBeGreaterThan(-1)

    expect(declarationsOf(layoutCss, '--layout-dialog-max-height').map(({ value }) => value))
      .toEqual(['calc(100dvh - 2rem)', 'calc(100vh - 2rem)'])
    expect(declarationsOf(layoutCss, '--layout-sheet-max-height').map(({ value }) => value))
      .toEqual(['85dvh', '85vh'])
    expect(declarationsOf(blockContents(layoutCss, supportIndex), '--layout-dialog-max-height')
      .map(({ value }) => value)).toEqual(['calc(100vh - 2rem)'])
    expect(declarationsOf(blockContents(layoutCss, supportIndex), '--layout-sheet-max-height')
      .map(({ value }) => value)).toEqual(['85vh'])
  })

  it('routes dialogs, the mobile sheet and the log console through the contract', () => {
    const problems = DIALOG_FILES.flatMap(file => {
      const source = readSource(file)
      return [
        ...(source.includes('100dvh') ? [`${file}: 仍包含 100dvh 字面量`] : []),
        ...(source.includes(DIALOG_MAX_HEIGHT_CLASS) ? [] : [`${file}: 缺少 ${DIALOG_MAX_HEIGHT_CLASS}`]),
      ]
    })

    const detailLayer = readSource('src/features/combat/components/CombatCopilotDetailLayer.tsx')
    if (detailLayer.includes('85dvh')) problems.push('CombatCopilotDetailLayer.tsx: 仍包含 85dvh 字面量')
    if (!detailLayer.includes(SHEET_MAX_HEIGHT_CLASS)) {
      problems.push(`CombatCopilotDetailLayer.tsx: 缺少 ${SHEET_MAX_HEIGHT_CLASS}`)
    }

    const logsCss = readSource('src/features/logs/styles/logs.css')
    if (logsCss.includes('55dvh')) problems.push('logs.css: 日志控制台仍使用 55dvh')
    if (!logsCss.includes('55svh')) problems.push('logs.css: 日志控制台未使用 55svh')

    expect(problems).toEqual([])
  })

  it('keeps bare viewport units on declared owners', () => {
    const missingOwners = [...BARE_VIEWPORT_UNIT_ALLOWLIST.keys()]
      .filter(file => !existsSync(join(WEB_ROOT, file)))
    expect(missingOwners).toEqual([])

    const files = [INDEX_HTML, ...collectSourceFiles(SOURCE_ROOT)]
    const violations = files.flatMap(file => {
      const path = webPath(file)
      if (BARE_VIEWPORT_UNIT_ALLOWLIST.has(path)) return []
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(VIEWPORT_UNIT_RE)].map(match => (
        `${path}:${lineOf(source, match.index ?? 0)} ${match[0]}`
      ))
    })

    expect(violations, '裸视口单位必须归入壳层 token 或登记局部例外').toEqual([])
  })
})
