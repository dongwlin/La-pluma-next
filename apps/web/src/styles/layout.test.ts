import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const STYLES_ROOT = fileURLToPath(new URL('.', import.meta.url))

const LAYOUT_TOKEN_DEFINITION_RE = /(--layout-[\w-]+)\s*:/g
const LAYOUT_TOKEN_REFERENCE_RE = /var\(\s*(--layout-[\w-]+)/g
const LEGACY_TOKEN_RE = new RegExp(`${'--la'}-${'pluma'}-` + '[\\w-]+', 'g')
const BOOT_STYLE_RE = /<style id="la-pluma-boot-style">([\s\S]*?)<\/style>/
const CUSTOM_PROPERTY_RE = /(--[\w-]+)\s*:\s*([^;]+);/g
const VAR_REFERENCE_RE = /var\(\s*(--[\w-]+)\s*\)/g

function customProperties(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(CUSTOM_PROPERTY_RE)].flatMap(match => (
      match[1] && match[2]
        ? [[match[1], match[2].replace(/\s+/g, ' ').trim()] as const]
        : []
    )),
  )
}

function resolveToken(
  name: string,
  properties: Map<string, string>,
  depth = 0,
): string {
  if (depth > 16) throw new Error(`token reference depth exceeded: ${name}`)

  const value = properties.get(name)
  if (value === undefined) throw new Error(`missing token declaration: ${name}`)

  return value.replace(
    VAR_REFERENCE_RE,
    (_match, reference: string) => resolveToken(reference, properties, depth + 1),
  ).replace(/\s+/g, ' ').trim()
}

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '__screenshots__',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])

function collectTextFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    if (IGNORED_DIRECTORIES.has(entry)) return []
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectTextFiles(path)
    return TEXT_EXTENSIONS.has(extname(path)) ? [path] : []
  })
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap(match => (match[1] ? [match[1]] : []))
}

describe('layout style layer', () => {
  it('defines every referenced --layout-* token in layout.css', () => {
    const layoutCss = readFileSync(join(STYLES_ROOT, 'layout.css'), 'utf8')
    const defined = new Set(matches(layoutCss, LAYOUT_TOKEN_DEFINITION_RE))
    const references: Array<{ token: string; file: string }> = []
    const foreignDefinitions: Array<{ token: string; file: string }> = []

    for (const file of collectTextFiles(REPO_ROOT)) {
      const source = readFileSync(file, 'utf8')
      const location = relative(REPO_ROOT, file)
      for (const token of matches(source, LAYOUT_TOKEN_REFERENCE_RE)) {
        references.push({ token, file: location })
      }
      for (const token of matches(source, LAYOUT_TOKEN_DEFINITION_RE)) {
        if (location !== join('apps', 'web', 'src', 'styles', 'layout.css')) {
          foreignDefinitions.push({ token, file: location })
        }
      }
    }

    expect(references.length).toBeGreaterThan(0)
    expect(references.filter(({ token }) => !defined.has(token))).toEqual([])
    expect(foreignDefinitions).toEqual([])
  })

  it('keeps legacy layout tokens out of the repository', () => {
    const legacy = collectTextFiles(REPO_ROOT).flatMap(file => (
      [...readFileSync(file, 'utf8').matchAll(LEGACY_TOKEN_RE)].map(([token]) => (
        `${relative(REPO_ROOT, file)}: ${token}`
      ))
    ))

    expect(legacy).toEqual([])
  })

  it('imports global styles in layout-aware order', () => {
    const entry = readFileSync(join(STYLES_ROOT, 'index.ts'), 'utf8')
    const imports = [...entry.matchAll(/^import\s+'\.\/([^']+)'\s*$/gm)].flatMap(match => (
      match[1] ? [match[1]] : []
    ))

    expect(imports).toEqual(['index.css', 'layout.css', 'ios-theme.css'])
  })

  it('keeps the boot shell geometry in sync with layout tokens', () => {
    const layoutTokens = customProperties(readFileSync(join(STYLES_ROOT, 'layout.css'), 'utf8'))
    const html = readFileSync(join(REPO_ROOT, 'apps', 'web', 'index.html'), 'utf8')
    const bootStyle = BOOT_STYLE_RE.exec(html)?.[1]
    if (!bootStyle) throw new Error('index.html 缺少启动壳样式块')
    const bootTokens = customProperties(bootStyle)

    const checks = [
      {
        label: '启动壳 navbar 高度',
        bootToken: '--boot-navbar-height',
        layoutToken: '--layout-navbar-height',
      },
      {
        label: '启动壳底部留白',
        bootToken: '--boot-bottom-clearance',
        layoutToken: '--layout-tabbar-bottom-clearance',
      },
    ]

    const mismatches = checks.flatMap(({ label, bootToken, layoutToken }) => {
      const bootValue = resolveToken(bootToken, bootTokens)
      const layoutValue = resolveToken(layoutToken, layoutTokens)
      if (bootValue === layoutValue) return []
      return [`${label}: index.html 的 ${bootToken} 为 ${bootValue}，layout.css 的 ${layoutToken} 为 ${layoutValue}`]
    })

    expect(mismatches).toEqual([])
  })
})
