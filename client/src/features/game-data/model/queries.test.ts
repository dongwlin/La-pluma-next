// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { gameDataKeys } from './queryKeys'
import { depotQueryOptions, operBoxQueryOptions, operatorCatalogQueryOptions } from './queries'

const apiMocks = vi.hoisted(() => ({
  getAllOperators: vi.fn(),
  getDepotData: vi.fn(),
  getOperBoxData: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

describe('game data query options', () => {
  beforeEach(() => {
    apiMocks.getAllOperators.mockReset()
    apiMocks.getDepotData.mockReset()
    apiMocks.getOperBoxData.mockReset()
  })

  it('uses one cache identity per shared resource in the game-data domain', () => {
    expect(depotQueryOptions().queryKey).toEqual(gameDataKeys.resource('depot'))
    expect(operBoxQueryOptions().queryKey).toEqual(gameDataKeys.resource('operbox'))
    expect(operatorCatalogQueryOptions().queryKey).toEqual(gameDataKeys.resource('catalog'))
  })

  it('keeps the empty depot snapshot and forwards the query signal', async () => {
    apiMocks.getDepotData.mockResolvedValue({ success: true, data: null })

    const data = await createQueryClient().fetchQuery(depotQueryOptions())

    expect(data).toBeNull()
    expect(apiMocks.getDepotData).toHaveBeenCalledOnce()
    expect(apiMocks.getDepotData.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
  })

  it('normalizes a depot snapshot without an items array', async () => {
    apiMocks.getDepotData.mockResolvedValue({
      success: true,
      data: { itemCount: 2, timestamp: '2026-10-25T00:00:00.000Z' },
    })

    const data = await createQueryClient().fetchQuery(depotQueryOptions())

    expect(data).toEqual({ itemCount: 2, timestamp: '2026-10-25T00:00:00.000Z', items: [] })
  })

  it('keeps an empty operbox snapshot and normalizes a missing data list', async () => {
    apiMocks.getOperBoxData
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({
        success: true,
        data: { operCount: 1, timestamp: '2026-10-25T00:00:00.000Z' },
      })

    const empty = await createQueryClient().fetchQuery(operBoxQueryOptions())
    const normalized = await createQueryClient().fetchQuery(operBoxQueryOptions())

    expect(empty).toBeNull()
    expect(normalized).toEqual({
      operCount: 1,
      timestamp: '2026-10-25T00:00:00.000Z',
      data: [],
    })
  })

  it('normalizes a catalog that is not an array to an empty list', async () => {
    apiMocks.getAllOperators.mockResolvedValue({ success: true, data: undefined })

    const data = await createQueryClient().fetchQuery(operatorCatalogQueryOptions())

    expect(data).toEqual([])
  })

  it('turns a failed envelope into a query error instead of cached data', async () => {
    apiMocks.getDepotData.mockResolvedValue({ success: false, message: '仓库服务不可用' })

    const error = await createQueryClient().fetchQuery(depotQueryOptions()).catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', retryable: false, message: '仓库服务不可用' })
  })
})
