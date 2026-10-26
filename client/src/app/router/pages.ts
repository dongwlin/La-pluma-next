import type { ComponentType } from 'react'
import Dashboard from '@/pages/dashboard/Dashboard'
import AutomationTasks from '@/pages/automation/AutomationTasks'
import CombatTasks from '@/pages/combat/CombatTasks'
import RoguelikeTasks from '@/pages/roguelike/RoguelikeTasks'
import OperatorTraining from '@/pages/training/OperatorTraining'
import LogViewer from '@/pages/logs/LogViewer'
import DataStatistics from '@/pages/statistics/DataStatistics'
import ConfigManager from '@/pages/settings/ConfigManager'
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
