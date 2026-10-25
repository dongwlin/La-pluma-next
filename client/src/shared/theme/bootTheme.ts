/**
 * 启动主题的单一真源。
 *
 * `createBootScript()` 负责在 Vite 构建期生成注入 index.html 的首帧脚本，
 * 运行时 store 直接复用 `applyTheme()`，两者共享同一组颜色与存储约定，
 * 避免首帧与 React 接管后出现两套实现漂移。
 *
 * 模块顶层不访问 document/window，构建期（Node）可安全导入。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'ui-storage'

const THEME_MODES = ['light', 'dark', 'system'] as const
const DEFAULT_THEME: ThemeMode = 'dark'

export const BOOT_THEME_COLORS = {
  light: {
    background: '#f2f2f7',
    themeColor: '#f6f8fb',
    statusBar: 'default',
  },
  dark: {
    background: '#000000',
    themeColor: '#05090c',
    statusBar: 'black-translucent',
  },
} as const

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

/** 解析 zustand persist 写入的 `{"state":{"theme":...}}`，非法值或损坏 JSON 回退深色。 */
export function readStoredTheme(raw: string | null): ThemeMode {
  if (!raw) return DEFAULT_THEME
  try {
    const parsed: unknown = JSON.parse(raw)
    const theme = (parsed as { state?: { theme?: unknown } } | null)?.state?.theme
    return isThemeMode(theme) ? theme : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function resolveDark(theme: ThemeMode, prefersDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && prefersDark)
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return

  const prefersDark = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  const dark = resolveDark(theme, prefersDark)
  const colors = dark ? BOOT_THEME_COLORS.dark : BOOT_THEME_COLORS.light
  const root = document.documentElement

  root.classList.toggle('dark', dark)
  document.getElementById('app-root')?.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  root.style.backgroundColor = colors.background
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', colors.themeColor)
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', colors.statusBar)
}

/**
 * 生成可内联的启动脚本：standalone 视口标记 + 从 persist 存储恢复主题，
 * 解析失败时回退深色。颜色、存储 key 与默认值都从本模块常量插值，
 * 脚本自身不再另抄一份 hex。
 */
export function createBootScript(): string {
  const modeList = THEME_MODES.map(mode => JSON.stringify(mode)).join(', ')
  const { light, dark } = BOOT_THEME_COLORS

  return `(() => {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true
  if (standalone) {
    // Claim the full iOS standalone viewport while keeping status icons
    // readable in both color schemes.
    document.documentElement.classList.add('la-pluma-standalone', 'device-full-viewport')
  }

  const applyTheme = (theme) => {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
    const dark = theme === 'dark' || (theme === 'system' && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
    document.getElementById('app-root')?.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.documentElement.style.backgroundColor = dark ? ${JSON.stringify(dark.background)} : ${JSON.stringify(light.background)}
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? ${JSON.stringify(dark.themeColor)} : ${JSON.stringify(light.themeColor)})
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? ${JSON.stringify(dark.statusBar)} : ${JSON.stringify(light.statusBar)})
  }
  try {
    const stored = JSON.parse(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || '{}').state
    const theme = [${modeList}].includes(stored?.theme) ? stored.theme : ${JSON.stringify(DEFAULT_THEME)}
    applyTheme(theme)
  } catch {
    applyTheme(${JSON.stringify(DEFAULT_THEME)})
  }
})()`
}
