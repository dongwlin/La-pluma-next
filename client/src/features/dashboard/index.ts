/**
 * Dashboard 域公开面
 */

import './styles/dashboard.css'

export { default as DashboardWorkspace } from './components/DashboardWorkspace'
export { DashboardSkeleton } from './components/DashboardSkeleton'
export { useDashboardSnapshotRefresh } from './hooks/useDashboardSnapshotRefresh'
export { useDashboardStore } from './store/dashboardStore'
