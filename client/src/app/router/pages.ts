import type { ComponentType } from 'react'
import Dashboard from '@/features/dashboard'
import AutomationTasks from '@/features/automation'
import CombatTasks from '@/features/combat'
import RoguelikeTasks from '@/features/roguelike'
import OperatorTraining from '@/features/training'
import LogViewer from '@/features/logs'
import DataStatistics from '@/features/statistics'
import ConfigManager from '@/features/settings'
import { appTabRoute, type AppTab } from '@/shared/navigation'

export interface AppRoute {
  id: AppTab
  path: string
  Component: ComponentType
}

/**
 * 路由表：tab id、规范 URL 与页面组件的静态映射。
 *
 * 这里只描述数据；实际渲染由 VisitedWorkspaces 保活完成，不交给
 * <Routes>/useRoutes（见 AppRoutes 的说明）。
 */
export const appRoutes = [
  { id: 'dashboard', path: appTabRoute('dashboard'), Component: Dashboard },
  { id: 'automation', path: appTabRoute('automation'), Component: AutomationTasks },
  { id: 'combat', path: appTabRoute('combat'), Component: CombatTasks },
  { id: 'roguelike', path: appTabRoute('roguelike'), Component: RoguelikeTasks },
  { id: 'training', path: appTabRoute('training'), Component: OperatorTraining },
  { id: 'logs', path: appTabRoute('logs'), Component: LogViewer },
  { id: 'statistics', path: appTabRoute('statistics'), Component: DataStatistics },
  { id: 'config', path: appTabRoute('config'), Component: ConfigManager },
] satisfies AppRoute[]
