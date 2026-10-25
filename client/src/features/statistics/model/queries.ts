/**
 * 数据统计域 Query 定义
 *
 * 掉落统计按天数区分缓存身份；同一天数内刷新失败保留上一次成功结果，
 * 切换天数时用占位数据让旧周期内容留在屏幕上（与迁移前的本地状态一致）。
 */

import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import { getDropStatistics } from '../api'
import type { DropStatistics } from '../types'
import { statisticsKeys } from './queryKeys'

export const dropStatisticsQueryOptions = (days: number) => queryOptions({
  queryKey: statisticsKeys.query('drops', days),
  queryFn: async ({ signal }): Promise<DropStatistics> => (
    unwrapApiResponse<DropStatistics>(await getDropStatistics(days, signal))
  ),
  placeholderData: keepPreviousData,
})
