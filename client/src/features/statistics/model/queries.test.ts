// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keepPreviousData } from '@tanstack/react-query'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { dropStatisticsQueryOptions } from './queries'
import { STATISTICS_DOMAIN, statisticsKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getDropStatistics: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

const statistics = {
  total: { sanity: 42, battles: 3, medicine: 0, stone: 0 },
  items: { 固源岩: { count: 6 } },
  stages: { '1-7': { battles: 3, sanity: 42, items: { 固源岩: 6 } } },
  dateRange: { start: '2026-10-18', end: '2026-10-25', days: 7 },
}

describe('statistics query options', () => {
  beforeEach(() => {
    apiMocks.getDropStatistics.mockReset()
  })

  it('scopes drops to the statistics domain and puts days in the cache identity', () => {
    expect(STATISTICS_DOMAIN).toBe('statistics')
    expect(dropStatisticsQueryOptions(7).queryKey).toEqual(statisticsKeys.query('drops', 7))
    expect(dropStatisticsQueryOptions(30).queryKey).toEqual(['statistics', 'drops', 30])
  })

  it('passes days and the query signal to the drops endpoint', async () => {
    apiMocks.getDropStatistics.mockResolvedValue({ success: true, data: statistics })

    const data = await createQueryClient().fetchQuery(dropStatisticsQueryOptions(14))

    expect(data).toEqual(statistics)
    expect(apiMocks.getDropStatistics).toHaveBeenCalledWith(14, expect.any(AbortSignal))
  })

  it('keeps the previous period visible while another days key loads', () => {
    expect(dropStatisticsQueryOptions(3).placeholderData).toBe(keepPreviousData)
  })

  it('surfaces a failed drops envelope as a query error', async () => {
    apiMocks.getDropStatistics.mockResolvedValue({ success: false, message: '统计服务不可用' })

    const error = await createQueryClient()
      .fetchQuery(dropStatisticsQueryOptions(7))
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', retryable: false, message: '统计服务不可用' })
  })
})
