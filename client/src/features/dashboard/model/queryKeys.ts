/**
 * 总览域 Query key
 *
 * 域标识 `dashboard` 与 feature 目录一致。`snapshot` 只用于完整快照的协调
 * 读取：它借用 Query 的单飞与失败传播，不长期保留第二份展示缓存；展示与
 * 持久化仍由 `dashboardStore` 的受控投影持有。
 */

import { defineQueryKeys } from '@/shared/query'

export const DASHBOARD_DOMAIN = 'dashboard' as const

export const dashboardKeys = defineQueryKeys(DASHBOARD_DOMAIN)

export type DashboardResource = 'snapshot'
