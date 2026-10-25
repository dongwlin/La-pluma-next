/**
 * 数据统计域 Query key
 *
 * 域标识 `statistics` 与 feature 目录一致；`drops` 的 `days` 参数影响响应内容，
 * 因此进入 key。仓库/持有干员/目录仍归 `game-data`，不在此重复建 key。
 */

import { defineQueryKeys } from '@/shared/query'

export const STATISTICS_DOMAIN = 'statistics' as const

export const statisticsKeys = defineQueryKeys(STATISTICS_DOMAIN)

export type StatisticsResource = 'drops'
