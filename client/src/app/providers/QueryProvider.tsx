import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { getQueryClient } from '@/shared/query'

/**
 * 应用级 Query Provider：注入模块级唯一客户端。
 * 页面卸载或 Activity 隐藏/恢复都不重建客户端、不清空缓存。
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>
}
