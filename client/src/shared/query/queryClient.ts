/**
 * 应用级 Query 客户端与默认策略
 *
 * 只负责服务端只读资源的缓存基础设施：
 * - 一个应用生命周期内稳定复用同一个客户端，页面 remount 不重建缓存；
 * - 只对可恢复的传输/服务端失败自动重试，contract 失败与调用方取消不重试；
 * - 默认不因文档焦点变化重取，避免 Activity 隐藏页面同时刷流量；网络重连时重取过期数据。
 *
 * 配置草稿、执行 Run 与日志/轮询会话都不属于本层，见 docs/query-cache.md。
 */

import { QueryClient, type DefaultOptions } from '@tanstack/react-query'
import { ApiRequestError, isAbortError } from '@/shared/api'

/** 数据在 30s 内视为新鲜；新鲜数据不会因 remount 或重连重复请求。 */
export const QUERY_STALE_TIME_MS = 30_000

/** 没有观察者后缓存保留 5 分钟；Activity 隐藏仍保留观察者，不受该值影响。 */
export const QUERY_GC_TIME_MS = 5 * 60_000

/** 自动重试次数上限（不含首次请求），因此最多 3 次尝试。 */
export const QUERY_RETRY_LIMIT = 2

const QUERY_RETRY_BASE_DELAY_MS = 500
const QUERY_RETRY_MAX_DELAY_MS = 4_000

/**
 * 只重试调用方可能通过重试恢复的失败：
 * 传输失败，以及服务端标记 `retryable` 的 API 失败。
 * contract 失败、非重试 API 失败、未知错误与取消都不重试。
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRY_LIMIT) return false
  if (isAbortError(error)) return false
  if (!(error instanceof ApiRequestError)) return false
  return error.kind === 'transport' || (error.kind === 'api' && error.retryable)
}

/** 500ms 起指数退避，单次等待上限 4s。 */
export function queryRetryDelay(failureCount: number): number {
  return Math.min(QUERY_RETRY_BASE_DELAY_MS * 2 ** failureCount, QUERY_RETRY_MAX_DELAY_MS)
}

export const queryDefaultOptions: DefaultOptions = {
  queries: {
    staleTime: QUERY_STALE_TIME_MS,
    gcTime: QUERY_GC_TIME_MS,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    networkMode: 'online',
  },
  // 写请求（配置提交、执行命令）不走 Query mutation；即便未来使用，也不自动重试。
  mutations: {
    retry: false,
    networkMode: 'online',
  },
}

/** 每个调用方独立的新客户端；测试或隔离环境使用。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryDefaultOptions })
}

let applicationQueryClient: QueryClient | undefined

/** 应用级唯一客户端；页面与 Provider 的 remount 不会新建缓存。 */
export function getQueryClient(): QueryClient {
  applicationQueryClient ??= createQueryClient()
  return applicationQueryClient
}
