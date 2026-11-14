import { createContext, useContext } from 'react'
import type { ThemeDefinition } from './registry'
import type { ThemeMode, UiThemeSettings } from './bootTheme'

export type ResolvedMode = 'light' | 'dark'

export interface ThemeContextValue extends UiThemeSettings {
  /** 实际生效的明暗（system 解析后）。 */
  resolvedMode: ResolvedMode
  activeTheme: ThemeDefinition
  setThemeId: (themeId: string) => void
  setMode: (mode: ThemeMode) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  return context
}
