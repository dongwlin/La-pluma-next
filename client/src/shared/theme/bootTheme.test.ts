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

/**
 * 在 `blockPattern` 命中的规则块里查找 property 的首个声明。
 * blockPattern 必须覆盖到块头并以 `{` 结尾，避免跨块误匹配。
 */
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

// 首帧背景色横跨两套无法共享代码的层：构建期常量（BOOT_THEME_COLORS）与
// 手写 CSS（index.html 的内联启动样式、index.css / ios-theme.css 的页面底色）。
// 不一致时表现为首帧闪一下旧色，截图拍不到。这是 docs/development/README.md 中
// 「禁止枚举式 grep CSS」的例外，用法与 animations.test.ts 相同：不枚举选择器
// 清单，只核对同一语义在两处的取值是否一致。
//
// 深色页面底色的候选有两个：index.css 的 --app-bg: #000 与 ios-theme.css 的
// --app-chrome-page-bg: #000000。两个文件同属 @layer base，ios-theme.css 后
// 加载，其 html, body { background: var(--app-chrome-page-bg) } 简写覆盖了
// index.css 的 background-color / background-image，所以真正画在页面上的
// 是 --app-chrome-page-bg，这里校验后者。
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
