// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { ApiRequestError, type ApiFailureKind } from '@/shared/api'
import {
  QUERY_GC_TIME_MS,
  QUERY_RETRY_LIMIT,
  QUERY_STALE_TIME_MS,
  createQueryClient,
  queryRetryDelay,
  shouldRetryQuery,
} from './queryClient'

function apiRequestError(kind: ApiFailureKind, retryable = false): ApiRequestError {
  return new ApiRequestError({
    kind,
    code: kind === 'transport' ? 'NETWORK_ERROR' : 'API_OPERATION_FAILED',
    message: '请求失败',
    retryable,
  })
}

function abortError(): Error {
  return Object.assign(new Error('请求已取消'), { name: 'AbortError' })
}

describe('query client defaults', () => {
  it('locks the documented stale, gc and retry policy', () => {
    expect([QUERY_STALE_TIME_MS, QUERY_GC_TIME_MS, QUERY_RETRY_LIMIT]).toEqual([30_000, 300_000, 2])

    const queries = createQueryClient().getDefaultOptions().queries

    expect(queries).toMatchObject({
      staleTime: 30_000,
      gcTime: 300_000,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      networkMode: 'online',
    })
    expect(queries?.retry).toBe(shouldRetryQuery)
    expect(queries?.retryDelay).toBe(queryRetryDelay)
  })

  it('never retries writes by default', () => {
    expect(createQueryClient().getDefaultOptions().mutations).toMatchObject({
      retry: false,
      networkMode: 'online',
    })
  })
})

describe('shouldRetryQuery', () => {
  it('retries transport and retryable api failures within the attempt limit', () => {
    expect(shouldRetryQuery(0, apiRequestError('transport', true))).toBe(true)
    expect(shouldRetryQuery(1, apiRequestError('transport', true))).toBe(true)
    expect(shouldRetryQuery(0, apiRequestError('api', true))).toBe(true)
    expect(shouldRetryQuery(1, apiRequestError('api', true))).toBe(true)

    expect(shouldRetryQuery(QUERY_RETRY_LIMIT, apiRequestError('transport', true))).toBe(false)
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT, apiRequestError('api', true))).toBe(false)
  })

  it('does not retry contract failures, non-retryable api failures or unknown errors', () => {
    expect(shouldRetryQuery(0, apiRequestError('contract'))).toBe(false)
    expect(shouldRetryQuery(0, apiRequestError('api', false))).toBe(false)
    expect(shouldRetryQuery(0, new Error('unexpected'))).toBe(false)
  })

  it('does not retry caller cancellation', () => {
    expect(shouldRetryQuery(0, abortError())).toBe(false)
  })
})

describe('queryRetryDelay', () => {
  it('uses capped exponential backoff', () => {
    expect(queryRetryDelay(0)).toBe(500)
    expect(queryRetryDelay(1)).toBe(1_000)
    expect(queryRetryDelay(5)).toBe(4_000)
  })
})
