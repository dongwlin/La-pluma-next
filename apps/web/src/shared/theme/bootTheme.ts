/**
 * 启动主题的单一真源：构建期注入的首帧脚本与运行时 Provider 共用同一组设置解析、
 * DOM 应用与存储迁移约定，避免两套实现漂移；模块顶层不访问 document/window，
 * 构建期（Node）可安全导入。
 */

import { DEFAULT_THEME_ID, THEMES, getTheme } from './registry'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface UiThemeSettings {
  themeId: string
  mode: ThemeMode
}

export const THEME_STORAGE_KEY = 'lpn-ui'
/** 旧 zustand persist 存储，只在升级迁移读取时出现，任何路径都不得再写入。 */
export const LEGACY_THEME_STORAGE_KEY = 'ui-storage'

const THEME_MODES = ['light', 'dark', 'system'] as const
const DEFAULT_MODE: ThemeMode = 'dark'

export const DEFAULT_THEME_SETTINGS: UiThemeSettings = { themeId: DEFAULT_THEME_ID, mode: DEFAULT_MODE }

const defaultTheme = getTheme(DEFAULT_THEME_ID) ?? THEMES[0]!

/** 首帧静态默认色卡（默认主题）；「主题 × 模式」的完整色卡在 ThemeDefinition.boot。 */
export const BOOT_THEME_COLORS = {
  light: defaultTheme.boot.light,
  dark: defaultTheme.boot.dark,
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

function isKnownThemeId(value: unknown): value is string {
  return typeof value === 'string' && getTheme(value) !== undefined
}

/** 解析 lpn-ui 明文 JSON（{themeId, mode}）；缺项逐项回退，两项皆缺失返回 null。 */
export function readStoredSettings(raw: string | null): UiThemeSettings | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { themeId, mode } = parsed as Partial<UiThemeSettings>
    if (!isKnownThemeId(themeId) && !isThemeMode(mode)) return null
    return {
      themeId: isKnownThemeId(themeId) ? themeId : DEFAULT_THEME_ID,
      mode: isThemeMode(mode) ? mode : DEFAULT_MODE,
    }
  } catch {
    return null
  }
}

/** 解析旧 ui-storage（zustand persist）写入的 `{"state":{"theme":...}}`，非法值或损坏 JSON 返回 null。 */
export function readLegacyThemeMode(raw: string | null): ThemeMode | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const theme = (parsed as { state?: { theme?: unknown } } | null)?.state?.theme
    return isThemeMode(theme) ? theme : null
  } catch {
    return null
  }
}

export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && prefersDark)
}

export function applyUiSettings(settings: UiThemeSettings, prefersDark?: boolean): void {
  if (typeof document === 'undefined') return

  const resolvedPrefersDark = prefersDark
    ?? (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
  const dark = resolveDark(settings.mode, resolvedPrefersDark)
  const theme = getTheme(settings.themeId) ?? defaultTheme
  const colors = dark ? theme.boot.dark : theme.boot.light
  const root = document.documentElement

  root.classList.toggle('dark', dark)
  document.getElementById('app-root')?.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  root.style.backgroundColor = colors.background
  if (theme.id === DEFAULT_THEME_ID) {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme.id)
  }
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', colors.themeColor)
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', colors.statusBar)
}

/** 生成可内联的启动脚本（standalone 视口标记 + 主题设置恢复 + 旧存储迁移读取）；数据从 registry 与本模块常量插值，脚本不另抄一份 hex。 */
export function createBootScript(): string {
  const modeList = THEME_MODES.map(mode => JSON.stringify(mode)).join(', ')
  const themeBootColors = JSON.stringify(Object.fromEntries(THEMES.map(theme => [theme.id, theme.boot])))
  const defaultSettings = JSON.stringify(DEFAULT_THEME_SETTINGS)
  const storageKey = JSON.stringify(THEME_STORAGE_KEY)
  const legacyKey = JSON.stringify(LEGACY_THEME_STORAGE_KEY)
  const defaultThemeId = JSON.stringify(DEFAULT_THEME_ID)

  return `(() => {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true
  if (standalone) {
    // Claim the full iOS standalone viewport while keeping status icons
    // readable in both color schemes.
    document.documentElement.classList.add('la-pluma-standalone', 'device-full-viewport')
  }

  const themeBootColors = ${themeBootColors}
  const defaultSettings = ${defaultSettings}
  const modes = [${modeList}]
  const applySettings = (settings) => {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
    const dark = settings.mode === 'dark' || (settings.mode === 'system' && prefersDark)
    const boot = themeBootColors[settings.themeId] ?? themeBootColors[defaultSettings.themeId]
    const colors = dark ? boot.dark : boot.light
    document.documentElement.classList.toggle('dark', dark)
    document.getElementById('app-root')?.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.documentElement.style.backgroundColor = colors.background
    if (settings.themeId === ${defaultThemeId}) document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', settings.themeId)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.themeColor)
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', colors.statusBar)
  }
  const readSettings = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(${storageKey}) || 'null')
      if (stored && typeof stored === 'object') {
        const themeId = themeBootColors[stored.themeId] ? stored.themeId : null
        const mode = modes.includes(stored.mode) ? stored.mode : null
        if (themeId || mode) {
          return { themeId: themeId || defaultSettings.themeId, mode: mode || defaultSettings.mode }
        }
      }
    } catch {}
    // 旧 ui-storage 读到即迁移（zustand persist 形态）；迁移落盘由运行时 Provider 完成。
    try {
      const legacy = JSON.parse(localStorage.getItem(${legacyKey}) || 'null')
      const mode = legacy && legacy.state && modes.includes(legacy.state.theme) ? legacy.state.theme : null
      if (mode) return { themeId: defaultSettings.themeId, mode }
    } catch {}
    return defaultSettings
  }
  applySettings(readSettings())
})()`
}
