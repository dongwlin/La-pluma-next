// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  BOOT_THEME_COLORS,
  createBootScript,
  readStoredTheme,
  resolveDark,
  THEME_STORAGE_KEY,
} from './bootTheme'

let systemDark = false

function installThemeEnvironment() {
  systemDark = false
  window.localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && systemDark,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = '<div id="app-root"></div>'
  document.head.innerHTML = [
    '<meta name="theme-color" content="" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="" />',
  ].join('')
}

describe('readStoredTheme', () => {
  it.each(['light', 'dark', 'system'] as const)('reads the stored %s preference', (theme) => {
    expect(readStoredTheme(JSON.stringify({ state: { theme } }))).toBe(theme)
  })

  it('falls back to dark for unsupported or missing state', () => {
    expect(readStoredTheme(JSON.stringify({ state: { theme: 'sepia' } }))).toBe('dark')
    expect(readStoredTheme(JSON.stringify({ state: {} }))).toBe('dark')
    expect(readStoredTheme(JSON.stringify({}))).toBe('dark')
    expect(readStoredTheme(null)).toBe('dark')
  })

  it('falls back to dark when the persisted JSON is corrupt', () => {
    expect(readStoredTheme('{invalid-json')).toBe('dark')
  })
})

describe('resolveDark', () => {
  it('resolves explicit themes and the system preference independently', () => {
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('light', true)).toBe(false)
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
})

describe('applyTheme', () => {
  beforeEach(installThemeEnvironment)

  it.each([
    {
      theme: 'light',
      systemDark: false,
      dark: false,
      background: 'rgb(242, 242, 247)',
      themeColor: '#f6f8fb',
      statusBar: 'default',
    },
    {
      theme: 'dark',
      systemDark: false,
      dark: true,
      background: 'rgb(0, 0, 0)',
      themeColor: '#05090c',
      statusBar: 'black-translucent',
    },
    {
      theme: 'system',
      systemDark: true,
      dark: true,
      background: 'rgb(0, 0, 0)',
      themeColor: '#05090c',
      statusBar: 'black-translucent',
    },
    {
      theme: 'system',
      systemDark: false,
      dark: false,
      background: 'rgb(242, 242, 247)',
      themeColor: '#f6f8fb',
      statusBar: 'default',
    },
  ] as const)('applies $theme with systemDark=$systemDark', ({
    theme,
    systemDark: prefersDark,
    dark,
    background,
    themeColor,
    statusBar,
  }) => {
    systemDark = prefersDark

    applyTheme(theme)

    expect(document.documentElement.classList.contains('dark')).toBe(dark)
    expect(document.getElementById('app-root')?.classList.contains('dark')).toBe(dark)
    expect(document.documentElement.style.colorScheme).toBe(dark ? 'dark' : 'light')
    expect(document.documentElement.style.backgroundColor).toBe(background)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(themeColor)
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe(statusBar)
  })
})

describe('createBootScript', () => {
  beforeEach(installThemeEnvironment)

  it('boots into the dark default when no preference is stored', () => {
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()

    window.eval(createBootScript())

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.style.backgroundColor).toBe('rgb(0, 0, 0)')
  })
})

// jsdom 环境下 import.meta.url 不是 file: 协议，按 vitest 的 client 根目录取源文件。
const CLIENT_ROOT = cwd()

interface CssDeclaration {
  value: string
  line: number
}

function findDeclaration(
  source: string,
  blockPattern: RegExp,
  property: string,
): CssDeclaration | null {
  const block = blockPattern.exec(source)
  if (!block) return null

  const bodyStart = block.index + block[0].length
  let depth = 1
  let bodyEnd = source.length
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) {
      bodyEnd = index
      break
    }
  }

  const declaration = new RegExp(`(?:^|[\\s;])${property}\\s*:\\s*([^;}]+)`)
    .exec(source.slice(bodyStart, bodyEnd))
  const value = declaration?.[1]?.trim()
  if (!declaration || !value) return null

  return {
    value,
    line: source.slice(0, bodyStart + declaration.index).split('\n').length,
  }
}

// 首帧背景色横跨两套无法共享代码的层：构建期常量（BOOT_THEME_COLORS）与手写 CSS
// （index.html 内联启动样式、index.css / ios-theme.css 页面底色）；不一致时首帧会闪旧色。
// 这是 docs/development/README.md「禁止枚举式 grep CSS」的例外（同 animations.test.ts）：
// 不枚举选择器清单，只核对同一语义在两处的取值一致。深色页面底色候选有两个：
// index.css 的 --app-bg 与 ios-theme.css 的 --app-chrome-page-bg；两者同属 @layer base，
// ios-theme.css 后加载，其 html, body { background: ... } 简写覆盖前者，因此校验后者。
describe('first-paint background colors', () => {
  const checks = [
    {
      label: 'index.html light --boot-bg',
      file: 'index.html',
      blockPattern: /^\s*:root\s*\{/m,
      property: '--boot-bg',
      expected: BOOT_THEME_COLORS.light.background,
    },
    {
      label: 'index.html dark --boot-bg',
      file: 'index.html',
      blockPattern: /^\s*html\.dark\s*\{/m,
      property: '--boot-bg',
      expected: BOOT_THEME_COLORS.dark.background,
    },
    {
      label: 'index.css light page background',
      file: 'src/styles/index.css',
      blockPattern: /^\s*:root\s*\{/m,
      property: '--app-bg',
      expected: BOOT_THEME_COLORS.light.background,
    },
    {
      label: 'ios-theme.css dark page background',
      file: 'src/styles/ios-theme.css',
      blockPattern: /^\s*html\.dark,\s*\n\s*#app-root\.dark\s*\{/m,
      property: '--app-chrome-page-bg',
      expected: BOOT_THEME_COLORS.dark.background,
    },
  ]

  it('keeps hand-written first-paint backgrounds in sync with BOOT_THEME_COLORS', () => {
    const mismatches = checks.flatMap(({ label, file, blockPattern, property, expected }) => {
      const source = readFileSync(join(CLIENT_ROOT, file), 'utf8')
      const declaration = findDeclaration(source, blockPattern, property)

      if (!declaration) {
        return [`${label}: ${file} 中找不到 ${property} 声明`]
      }
      if (declaration.value.toLowerCase() === expected.toLowerCase()) return []
      return [`${label}: ${file}:${declaration.line} 期望 ${expected}，实际 ${declaration.value}`]
    })

    expect(mismatches).toEqual([])
  })
})
