// 显式搜索使用 `staleTime: 0`，同一搜索词再次提交也会重新读取；返回的 outcome
// 带请求代次，被取消或被新搜索取代的 Promise 返回 `cancelled`。Activity 隐藏/卸载
// 只取消在途搜索、不自动重放，已成功的结果仍留在 Query 缓存。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ApiRequestError, isAbortError, type ApiFailureKind } from '@/shared/api'
import type { CopilotSearchResult, ParadoxSearchResult } from '../types'
import { combatKeys } from '../model/queryKeys'
import {
  copilotSearchQueryOptions,
  paradoxSearchQueryOptions,
} from '../model/queries'

export type CopilotSearchOutcome<T> =
  | { readonly status: 'success'; readonly result: T }
  | {
      readonly status: 'failed'
      readonly message: string
      readonly kind: ApiFailureKind | 'unknown'
    }
  | { readonly status: 'cancelled' }

export interface UseCopilotSearchResult<T> {
  readonly result: T | null
  readonly searching: boolean
  /** 提交一次搜索；返回本次代次是否仍当前以及成功/失败结论。 */
  readonly search: (term: string) => Promise<CopilotSearchOutcome<T>>
  /** 输入变化或页面隐藏时取消在途搜索；保留上次成功结果。 */
  readonly cancel: () => void
}

type SearchKind = 'copilot' | 'paradox'

const SEARCH_RESOURCE: Record<SearchKind, 'copilot-search' | 'paradox-search'> = {
  copilot: 'copilot-search',
  paradox: 'paradox-search',
}

function describeSearchFailure(
  error: unknown,
): { message: string; kind: ApiFailureKind | 'unknown' } {
  if (error instanceof ApiRequestError) return { message: error.message, kind: error.kind }
  if (error instanceof Error && error.message) return { message: error.message, kind: 'unknown' }
  return { message: '搜索失败', kind: 'unknown' }
}

function useCombatSearch<T>(kind: SearchKind): UseCopilotSearchResult<T> {
  const client = useQueryClient()
  const [term, setTerm] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const generation = useRef(0)

  const query = useQuery({
    ...(kind === 'copilot'
      ? copilotSearchQueryOptions(term ?? '')
      : paradoxSearchQueryOptions(term ?? '')),
    enabled: term !== null,
  } as never) as UseQueryResult<T>

  const cancel = useCallback(() => {
    generation.current += 1
    setPending(false)
    void client.cancelQueries({ queryKey: combatKeys.resource(SEARCH_RESOURCE[kind]) })
  }, [client, kind])

  // Activity 隐藏与真正卸载都会走清理；不触发新搜索。
  useEffect(() => cancel, [cancel])

  const search = useCallback(async (next: string): Promise<CopilotSearchOutcome<T>> => {
    const trimmed = next.trim()
    if (!trimmed) return { status: 'cancelled' }

    const requestId = ++generation.current
    setTerm(trimmed)
    setPending(true)
    try {
      const options = kind === 'copilot'
        ? copilotSearchQueryOptions(trimmed)
        : paradoxSearchQueryOptions(trimmed)
      // 显式搜索总是重新读取；被取消或取代的 Promise 由代次裁决。
      const result = await client.fetchQuery({ ...options, staleTime: 0 } as never) as T
      if (generation.current !== requestId) return { status: 'cancelled' }
      return { status: 'success', result }
    } catch (error) {
      if (generation.current !== requestId || isAbortError(error)) {
        return { status: 'cancelled' }
      }
      return { status: 'failed', ...describeSearchFailure(error) }
    } finally {
      if (generation.current === requestId) setPending(false)
    }
  }, [client, kind])

  return {
    result: (query.data ?? null) as T | null,
    searching: pending,
    search,
    cancel,
  }
}

export function useCopilotSearch(): UseCopilotSearchResult<CopilotSearchResult> {
  return useCombatSearch<CopilotSearchResult>('copilot')
}

export function useParadoxSearch(): UseCopilotSearchResult<ParadoxSearchResult> {
  return useCombatSearch<ParadoxSearchResult>('paradox')
}
