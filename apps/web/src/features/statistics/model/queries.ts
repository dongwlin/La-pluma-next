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
