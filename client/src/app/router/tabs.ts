import { BarChart3, Bot, Dices, FileText, GraduationCap, LayoutGrid, Settings2, Swords } from 'lucide-react'
import type { AppTab } from '@/shared/navigation'

export interface AppTabDefinition {
  id: AppTab
  name: string
  icon: typeof LayoutGrid
}

/**
 * 顶层工作区元数据：顺序即桌面侧栏与移动端页面的展示顺序。
 */
export const appTabs = [
  { id: 'dashboard', name: '概览', icon: LayoutGrid },
  { id: 'automation', name: '日常', icon: Bot },
  { id: 'combat', name: '作业', icon: Swords },
  { id: 'roguelike', name: '肉鸽', icon: Dices },
  { id: 'training', name: '养成', icon: GraduationCap },
  { id: 'statistics', name: '数据', icon: BarChart3 },
  { id: 'logs', name: '日志', icon: FileText },
  { id: 'config', name: '配置', icon: Settings2 },
] satisfies AppTabDefinition[]
