/**
 * UI Store - 管理主题偏好
 */

import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

type ThemeMode = 'light' | 'dark' | 'system'

interface UIState {
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
}

type ThemeRuntimeWindow = Window & {
  __LA_PLUMA_APPLY_THEME__?: (theme: ThemeMode) => void
}

export function applyThemePreference(theme: ThemeMode) {
  if (typeof document === 'undefined') return

  const runtime = typeof window === 'undefined'
    ? undefined
    : (window as ThemeRuntimeWindow).__LA_PLUMA_APPLY_THEME__
  if (runtime) {
    runtime(theme)
    return
  }

  const isDark = theme === 'dark'
    || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', isDark)
  document.getElementById('app-root')?.classList.toggle('dark', isDark)
  root.style.colorScheme = isDark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', isDark ? '#05090c' : '#f6f8fb')
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', isDark ? 'black-translucent' : 'default')
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
        name: 'ui-storage',
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
