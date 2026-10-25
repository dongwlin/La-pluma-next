/**
 * Shared Query 公开面
 * 只保留与业务无关的 Query 客户端、默认策略与 key 工厂；
 * 各域的资源 key 与查询定义由所属 feature 持有。
 */

export {
  QUERY_GC_TIME_MS,
  QUERY_RETRY_LIMIT,
  QUERY_STALE_TIME_MS,
  createQueryClient,
  getQueryClient,
  queryDefaultOptions,
  queryRetryDelay,
  shouldRetryQuery,
} from './queryClient'
export { defineQueryKeys } from './queryKeys'
export type { DomainQueryKey, QueryKeyFactory } from './queryKeys'
