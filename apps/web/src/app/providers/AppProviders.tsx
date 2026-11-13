import { MotionConfig } from 'framer-motion'
import { useEffect, type ReactNode } from 'react'
import { useUIStore } from '@/shared/stores'
import { QueryProvider } from './QueryProvider'

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
