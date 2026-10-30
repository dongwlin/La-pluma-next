/**
 * 养成队列、候选列表与状态计数 Query 定义
 *
 * 三个资源都由本域持有，页面只读取 query 结果，不再保存请求 id、loading
 * 或错误状态。队列写入由 `queueCommands` 领域命令在写成功后把权威快照写入
 * 同一 `queue` key；共享干员目录与持有干员仍由 `game-data` 提供端点与类型：
 * 候选 `all` 的旧兼容补齐与计数回退在查询内部读取它们，不建立第二份
 * Query key 或可写资源。
 *
 * 失败语义保持迁移前的差异：
 * - 队列与候选列表失败成为 query error，页面清空列表并展示可重试错误；
 * - 计数失败不展示错误，Query 保留上一次成功数据（同 key 重新读取失败时）。
 */

import { keepPreviousData, queryOptions, type QueryClient } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import {
  operBoxQueryOptions,
  operatorCatalogQueryOptions,
  type OperatorDetailed,
} from '@/features/game-data'
import { getOperatorList, getTrainingQueue } from '../api'
import type {
  TrainingOperator,
  TrainingQueueSnapshot,
  TrainingStatusCounts,
} from '../types'
import {
  buildAllCandidateRows,
  extractOperatorRows,
  type TrainingCandidateFilters,
} from './candidates'
import { trainingKeys } from './queryKeys'
import { buildTrainingStatusCounts, mergeTrainingStatusCounts } from './statusCounts'

export interface TrainingStatusCountsFilters {
  rarity?: number | null
  needsElite2?: boolean
}

/**
 * 养成队列的唯一读取入口。
 *
 * 页面与 Dashboard 不再各自保存队列副本；写成功后由领域命令把权威快照写入
 * 同一 key。失败转换为 Query 错误，取消保持 `AbortError`。
 */
export const trainingQueueQueryOptions = () => queryOptions({
  queryKey: trainingKeys.resource('queue'),
  queryFn: async ({ signal }): Promise<TrainingQueueSnapshot> => (
    unwrapApiResponse<TrainingQueueSnapshot>(await getTrainingQueue(signal))
  ),
})

const toOperatorListFilters = (filters: TrainingCandidateFilters) => ({
  status: filters.status,
  rarity: filters.rarity ?? undefined,
  needsElite2: filters.needsElite2 ?? false,
})

const readCandidateRows = async (
  filters: TrainingCandidateFilters,
  signal: AbortSignal,
): Promise<TrainingOperator[]> => {
  const response = await getOperatorList(toOperatorListFilters(filters), signal)
  return extractOperatorRows(unwrapApiResponse(response))
}

/**
 * 目录与持有干员属于 `game-data` 的共享只读资源。这里通过 QueryClient 的
 * `fetchQuery` 复用同一 key，缓存新鲜时不会重复下载大载荷，也避免与统计页
 * 各自维护一份同义快照。
 */
const readOperatorCatalog = async (
  client: QueryClient,
  signal: AbortSignal,
): Promise<OperatorDetailed[]> => {
  const options = operatorCatalogQueryOptions()
  return client.fetchQuery({
    ...options,
    // fetchQuery 没有外置 signal 参数；把调用方 signal 交给共享 queryFn，
    // 训练请求取消时同时中止底层目录读取。
    queryFn: context => options.queryFn!({ ...context, signal }),
  })
}

const readOperBoxRows = async (
  client: QueryClient,
  signal: AbortSignal,
): Promise<OperatorDetailed[]> => {
  const options = operBoxQueryOptions()
  const operBox = await client.fetchQuery({
    ...options,
    queryFn: context => options.queryFn!({ ...context, signal }),
  })
  return operBox?.data ?? []
}

/**
 * 候选列表按状态、稀有度与“未精二”条件区分缓存身份。
 * `status=all` 且端点返回空列表时沿用旧兼容补齐（目录 + 持有干员）。
 */
export const trainingCandidatesQueryOptions = (filters: TrainingCandidateFilters) => queryOptions({
  queryKey: trainingKeys.query(
    'candidates',
    filters.status,
    filters.rarity ?? null,
    filters.needsElite2 ?? false,
  ),
  queryFn: async ({ client, signal }): Promise<TrainingOperator[]> => {
    const rows = await readCandidateRows(filters, signal)
    if (filters.status !== 'all' || rows.length > 0) return rows

    const [catalog, ownedOperators] = await Promise.all([
      readOperatorCatalog(client, signal),
      readOperBoxRows(client, signal),
    ])
    return buildAllCandidateRows(catalog, ownedOperators, filters.rarity ?? null)
  },
})

/**
 * 三种状态计数使用固定筛选（稀有度、未精二），与当前列表状态无关。
 * 同 key 刷新失败时 Query 保留上次数据；`all` 为 0 时由 structuralSharing
 * 保留旧值，避免目录暂不可用时把“全部”显示成 0。
 */
export const trainingStatusCountsQueryOptions = (
  filters: TrainingStatusCountsFilters,
) => queryOptions({
  queryKey: trainingKeys.query('counts', filters.rarity ?? null, filters.needsElite2 ?? false),
  queryFn: async ({ client, signal }): Promise<TrainingStatusCounts> => {
    const [trainableRows, ownedRows, catalog, operBoxRows] = await Promise.all([
      readCandidateRows({ status: 'trainable', ...filters }, signal),
      readCandidateRows({ status: 'owned', ...filters }, signal),
      readOperatorCatalog(client, signal),
      readOperBoxRows(client, signal),
    ])

    return buildTrainingStatusCounts({
      trainableRows,
      ownedRows,
      catalog,
      operBoxRows,
      filters,
    })
  },
  placeholderData: keepPreviousData,
  structuralSharing: (previous, next) => mergeTrainingStatusCounts(
    previous as TrainingStatusCounts | undefined,
    next as TrainingStatusCounts,
  ),
})
