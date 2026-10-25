/**
 * UI Store - 管理主题偏好
 */

import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { applyTheme, THEME_STORAGE_KEY, type ThemeMode } from '../theme/bootTheme'

interface UIState {
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
}

export function applyThemePreference(theme: ThemeMode) {
  applyTheme(theme)
}

export const useUIStore = create<UIState>()(
  devtools(
    persist(
      (set) => ({
        theme: 'dark',

        setTheme: (theme) => {
          set({ theme })
          applyThemePreference(theme)
        },
      }),
      {
        name: THEME_STORAGE_KEY,
        partialize: (state) => ({
          theme: state.theme,
        }),
        merge: (persisted, current) => {
          const stored = persisted as Partial<Pick<UIState, 'theme'>> | undefined
          return {
            ...current,
            ...(stored?.theme && ['light', 'dark', 'system'].includes(stored.theme)
              ? { theme: stored.theme }
              : {}),
          }
        },
        onRehydrateStorage: () => (state) => {
          if (state) applyThemePreference(state.theme)
        },
      }
    ),
    { name: 'UIStore' }
  )
)

if (typeof window !== 'undefined') {
  applyThemePreference(useUIStore.getState().theme)
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)')
  const handleSystemThemeChange = () => {
    if (useUIStore.getState().theme === 'system') applyThemePreference('system')
  }

  // Safari/WebViews before the modern MediaQueryList API expose addListener only.
  if (systemTheme && typeof systemTheme.addEventListener === 'function') {
    systemTheme.addEventListener('change', handleSystemThemeChange)
  } else {
    systemTheme?.addListener?.(handleSystemThemeChange)
  }
}
