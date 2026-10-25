import { MotionConfig } from 'framer-motion'
import { useEffect, type ReactNode } from 'react'
import { useUIStore } from '@/shared/stores'
import { QueryProvider } from './QueryProvider'

/**
 * 全局 Provider 与副作用：应用级 Query 缓存、主题 dark class、全局动效偏好
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const theme = useUIStore(state => state.theme)
  const isDark = theme === 'dark'
    || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    document.getElementById('app-root')?.classList.toggle('dark', isDark)
  }, [isDark])

  return (
    <QueryProvider>
      <MotionConfig reducedMotion="user">
        {children}
      </MotionConfig>
    </QueryProvider>
  )
}
