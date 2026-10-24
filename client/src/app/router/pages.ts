import Dashboard from '@/features/dashboard'
import AutomationTasks from '@/features/automation'
import CombatTasks from '@/features/combat'
import RoguelikeTasks from '@/features/roguelike'
import OperatorTraining from '@/features/training'
import LogViewer from '@/features/logs'
import DataStatistics from '@/features/statistics'
import ConfigManager from '@/features/settings'

/**
 * 页面注册表：tab id 到页面组件的静态映射
 */
export const appPages = [
  { id: 'dashboard', Component: Dashboard },
  { id: 'automation', Component: AutomationTasks },
  { id: 'combat', Component: CombatTasks },
  { id: 'roguelike', Component: RoguelikeTasks },
  { id: 'training', Component: OperatorTraining },
  { id: 'logs', Component: LogViewer },
  { id: 'statistics', Component: DataStatistics },
  { id: 'config', Component: ConfigManager },
] as const
