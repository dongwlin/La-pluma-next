/**
 * Shared Navigation - tab 词汇表与 router-relative 路径助手
 *
 * 路径助手只处理已去掉 Vite base path 的 pathname，与 useLocation() 的返回值一致；
 * 部署 base 由 App 传给 BrowserRouter 的 basename 统一处理（见 routerBasename()）。
 */

import { useLocation } from 'react-router'

export const APP_TABS = [
  'dashboard',
  'automation',
  'combat',
  'roguelike',
  'training',
  'logs',
  'statistics',
  'config',
] as const

export type AppTab = typeof APP_TABS[number]

export const DEFAULT_APP_TAB: AppTab = 'dashboard'

export function isAppTab(value: unknown): value is AppTab {
  return typeof value === 'string' && (APP_TABS as readonly string[]).includes(value)
}

export function appTabRoute(tab: AppTab): string {
  return `/app/${tab}`
}

export function appTabFromPathname(pathname: string): AppTab | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'app') return null

  const tab = segments[1]
  if (!tab) return DEFAULT_APP_TAB
  return isAppTab(tab) ? tab : null
}

export function routerBasename(): string {
  return import.meta.env.BASE_URL.replace(/\/+$/, '')
}

export function useActiveAppTab(): AppTab {
  const { pathname } = useLocation()
  return appTabFromPathname(pathname) ?? DEFAULT_APP_TAB
}
