/**
 * 数据统计域 Query 定义
 *
 * 掉落统计按天数区分缓存身份；同一天数内刷新失败保留上一次成功结果，
 * 切换天数时用占位数据让旧周期内容留在屏幕上（与迁移前的本地状态一致）。
 *
 * 今日掉落与今日开放关卡由总览完整快照读取，分别使用 `today-drops` 与
 * `open-stages` 资源名；两者在快照协调器内统一校验，不能各自提交半份总览。
 */

import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import { getDropStatistics, getOpenTodayStages, getTodayDrops } from '../api'
import type { DropStatistics } from '../types'
import { statisticsKeys } from './queryKeys'

export type TodayDropsPayload = unknown[] | Record<string, unknown>

export interface OpenTodayStagesPayload {
  open: unknown[]
  closed: unknown[]
}

export const dropStatisticsQueryOptions = (days: number) => queryOptions({
  queryKey: statisticsKeys.query('drops', days),
  queryFn: async ({ signal }): Promise<DropStatistics> => (
    unwrapApiResponse<DropStatistics>(await getDropStatistics(days, signal))
  ),
  placeholderData: keepPreviousData,
})

export const todayDropsQueryOptions = () => queryOptions({
  queryKey: statisticsKeys.query('today-drops'),
  queryFn: async ({ signal }): Promise<TodayDropsPayload> => (
    unwrapApiResponse<TodayDropsPayload>(await getTodayDrops(signal))
  ),
})

export const openTodayStagesQueryOptions = () => queryOptions({
  queryKey: statisticsKeys.query('open-stages'),
  queryFn: async ({ signal }): Promise<OpenTodayStagesPayload> => (
    unwrapApiResponse<OpenTodayStagesPayload>(await getOpenTodayStages(signal))
  ),
})
