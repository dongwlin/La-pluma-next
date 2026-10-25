/**
 * 游戏数据共享 Query 定义
 *
 * 仓库、持有干员与干员目录被 statistics（本任务）与 training（FPR-044）共同读取，
 * query key、端点与载荷归一都归本域，页面不再各自维护加载状态。
 * 默认启用：页面首屏并行读取，是否读取不取决于当前 tab。
 */

import { queryOptions } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import { getAllOperators, getDepotData, getOperBoxData } from '../api'
import type { DepotDataDetailed, OperBoxData, OperatorDetailed } from '../types'
import { gameDataKeys } from './queryKeys'

/**
 * 仓库快照：旧服务端可能返回 `data: null`（尚无识别结果），保留 null 交给页面
 * 展示空状态；缺失的 `items` 归一为空数组，其余字段保持原样。
 */
export const depotQueryOptions = () => queryOptions({
  queryKey: gameDataKeys.resource('depot'),
  queryFn: async ({ signal }): Promise<DepotDataDetailed | null> => {
    const data = unwrapApiResponse<DepotDataDetailed | null>(await getDepotData(signal))
    return data ? { ...data, items: data.items ?? [] } : null
  },
})

/** 持有干员快照：空结果保留 null；缺失的 `data` 归一为空数组。 */
export const operBoxQueryOptions = () => queryOptions({
  queryKey: gameDataKeys.resource('operbox'),
  queryFn: async ({ signal }): Promise<OperBoxData | null> => {
    const data = unwrapApiResponse<OperBoxData | null>(await getOperBoxData(signal))
    return data ? { ...data, data: data.data ?? [] } : null
  },
})

/** 全量干员目录：旧载荷缺失时归一为空数组，页面据此区分空目录与读取失败。 */
export const operatorCatalogQueryOptions = () => queryOptions({
  queryKey: gameDataKeys.resource('catalog'),
  queryFn: async ({ signal }): Promise<OperatorDetailed[]> => {
    const data = unwrapApiResponse<OperatorDetailed[]>(await getAllOperators(signal))
    return Array.isArray(data) ? data : []
  },
})
