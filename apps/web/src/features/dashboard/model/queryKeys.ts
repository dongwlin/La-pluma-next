import { defineQueryKeys } from '@/shared/query'

export const DASHBOARD_DOMAIN = 'dashboard' as const

export const dashboardKeys = defineQueryKeys(DASHBOARD_DOMAIN)

export type DashboardResource = 'snapshot'
