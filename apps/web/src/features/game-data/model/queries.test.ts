// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import { GAME_DATA_DOMAIN, gameDataKeys } from './queryKeys'
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

  it('keeps the game-data domain as the invalidation scope', () => {
    expect(GAME_DATA_DOMAIN).toBe('game-data')
    expect(gameDataKeys.all).toEqual(['game-data'])
  })

  it('uses one cache identity per shared resource in the game-data domain', () => {
    expect(depotQueryOptions().queryKey).toEqual(gameDataKeys.resource('depot'))
    expect(operBoxQueryOptions().queryKey).toEqual(gameDataKeys.resource('operbox'))
    expect(operatorCatalogQueryOptions().queryKey).toEqual(gameDataKeys.resource('catalog'))
  })

  it('keeps the empty depot snapshot', async () => {
    apiMocks.getDepotData.mockResolvedValue({ success: true, data: null })

    const data = await createQueryClient().fetchQuery(depotQueryOptions())

    expect(data).toBeNull()
    expect(apiMocks.getDepotData).toHaveBeenCalledOnce()
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
})
