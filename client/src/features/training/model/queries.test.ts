// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keepPreviousData } from '@tanstack/react-query'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { trainingCandidatesQueryOptions, trainingQueueQueryOptions, trainingStatusCountsQueryOptions } from './queries'
import { TRAINING_DOMAIN, trainingKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getOperatorList: vi.fn(),
  getTrainingQueue: vi.fn(),
  getAllOperators: vi.fn(),
  getOperBoxData: vi.fn(),
}))

vi.mock('../api', () => ({
  getOperatorList: apiMocks.getOperatorList,
  getTrainingQueue: apiMocks.getTrainingQueue,
}))

vi.mock('@/features/game-data', () => ({
  getAllOperators: apiMocks.getAllOperators,
  getOperBoxData: apiMocks.getOperBoxData,
}))

const operatorRow = (id: string, rarity = 6) => ({
  id,
  name: id,
  rarity,
  profession: 'SNIPER',
  currentElite: 0,
  targetElite: 2,
})

describe('training queue query options', () => {
  beforeEach(() => {
    apiMocks.getTrainingQueue.mockReset()
  })

  it('uses the reserved queue resource identity inside the training domain', () => {
    expect(trainingQueueQueryOptions().queryKey).toEqual(trainingKeys.resource('queue'))
    expect(trainingQueueQueryOptions().queryKey).toEqual(['training', 'queue'])
  })

  it('reads the queue snapshot with the query signal and keeps its metadata', async () => {
    apiMocks.getTrainingQueue.mockResolvedValue({
      success: true,
      data: {
        queue: [{ operatorId: 'char_1' }],
        settings: { useMedicine: 1, useStone: 0, autoSwitch: true, notifyOnComplete: false },
        revision: 'revision-1',
        lastUpdated: '2026-10-26T00:00:00.000Z',
        flowSync: { status: 'synced', flowName: '自动任务', taskName: 'Fight' },
      },
    })

    const data = await createQueryClient().fetchQuery(trainingQueueQueryOptions())

    expect(apiMocks.getTrainingQueue).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(data).toMatchObject({
      queue: [{ operatorId: 'char_1' }],
      revision: 'revision-1',
      flowSync: { status: 'synced' },
    })
  })

  it('turns a failed queue envelope into a query error instead of an empty queue', async () => {
    apiMocks.getTrainingQueue.mockResolvedValue({
      success: false,
      message: '养成队列服务不可用',
    })

    const error = await createQueryClient()
      .fetchQuery(trainingQueueQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ message: '养成队列服务不可用' })
  })
})

describe('training candidate query options', () => {
  beforeEach(() => {
    apiMocks.getOperatorList.mockReset()
    apiMocks.getAllOperators.mockReset()
    apiMocks.getOperBoxData.mockReset()
  })

  it('scopes candidates to the training domain and keeps filters in the cache identity', () => {
    expect(TRAINING_DOMAIN).toBe('training')
    expect(trainingCandidatesQueryOptions({
      status: 'trainable',
      rarity: 6,
      needsElite2: true,
    }).queryKey).toEqual(trainingKeys.query('candidates', 'trainable', 6, true))
    expect(trainingCandidatesQueryOptions({ status: 'all' }).queryKey)
      .toEqual(['training', 'candidates', 'all', null, false])
    expect(trainingKeys.resource('candidates')).toEqual(['training', 'candidates'])
    expect(trainingKeys.resource('counts')).toEqual(['training', 'counts'])
  })

  it('reads the endpoint with normalized filters and forwards the query signal', async () => {
    apiMocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operatorRow('char_1')] },
    })

    const data = await createQueryClient().fetchQuery(
      trainingCandidatesQueryOptions({ status: 'owned', rarity: 6, needsElite2: true }),
    )

    expect(data).toEqual([operatorRow('char_1')])
    expect(apiMocks.getOperatorList).toHaveBeenCalledWith(
      { status: 'owned', rarity: 6, needsElite2: true },
      expect.any(AbortSignal),
    )
    expect(apiMocks.getAllOperators).not.toHaveBeenCalled()
    expect(apiMocks.getOperBoxData).not.toHaveBeenCalled()
  })

  it('keeps the legacy top-level array payload', async () => {
    apiMocks.getOperatorList.mockResolvedValue({
      success: true,
      data: [operatorRow('char_legacy')],
    })

    const data = await createQueryClient().fetchQuery(
      trainingCandidatesQueryOptions({ status: 'trainable' }),
    )

    expect(data).toEqual([operatorRow('char_legacy')])
  })

  it('rebuilds an empty status=all list from the shared catalogue and operbox', async () => {
    apiMocks.getOperatorList.mockResolvedValue({ success: true, data: { operators: [] } })
    apiMocks.getAllOperators.mockResolvedValue({
      success: true,
      data: [
        { id: 'char_owned', name: '识别名', rarity: 6, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
        { id: 'char_unowned', name: '未拥有', rarity: 5, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
      ],
    })
    apiMocks.getOperBoxData.mockResolvedValue({
      success: true,
      data: {
        operCount: 1,
        data: [{ id: 'char_owned', name: '识别名', rarity: 6, profession: 'SNIPER', level: 80, elite: 1, potential: 2 }],
        timestamp: '2026-10-26T00:00:00.000Z',
      },
    })

    const data = await createQueryClient().fetchQuery(
      trainingCandidatesQueryOptions({ status: 'all' }),
    )

    expect(data.map(operator => [operator.id, operator.name, operator.owned])).toEqual([
      ['char_owned', '识别名', true],
      ['char_unowned', '未拥有', false],
    ])
    expect(apiMocks.getAllOperators).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(apiMocks.getOperBoxData).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('surfaces a failed candidate envelope as a query error without falling back', async () => {
    apiMocks.getOperatorList.mockResolvedValue({ success: false, message: '干员列表服务不可用' })

    const error = await createQueryClient()
      .fetchQuery(trainingCandidatesQueryOptions({ status: 'all' }))
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', retryable: false, message: '干员列表服务不可用' })
    expect(apiMocks.getAllOperators).not.toHaveBeenCalled()
  })
})

describe('training status count query options', () => {
  beforeEach(() => {
    apiMocks.getOperatorList.mockReset()
    apiMocks.getAllOperators.mockReset()
    apiMocks.getOperBoxData.mockReset()
  })

  it('keeps rarity and the elite condition in the counts cache identity', () => {
    expect(trainingStatusCountsQueryOptions({ rarity: 6, needsElite2: true }).queryKey)
      .toEqual(trainingKeys.query('counts', 6, true))
    expect(trainingStatusCountsQueryOptions({}).queryKey).toEqual(['training', 'counts', null, false])
    expect(trainingStatusCountsQueryOptions({ rarity: 6 }).placeholderData).toBe(keepPreviousData)
  })

  it('builds all three counts from the endpoint and shared snapshots with the query signal', async () => {
    apiMocks.getOperatorList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === 'trainable') {
        return {
          success: true,
          data: { operators: [operatorRow('char_a'), operatorRow('char_b')] },
        }
      }
      return { success: true, data: { operators: [operatorRow('char_a')] } }
    })
    apiMocks.getAllOperators.mockResolvedValue({
      success: true,
      data: [
        { id: 'char_a', name: 'A', rarity: 6, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
        { id: 'char_b', name: 'B', rarity: 6, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
        { id: 'char_c', name: 'C', rarity: 5, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
      ],
    })
    apiMocks.getOperBoxData.mockResolvedValue({ success: true, data: { data: [] } })

    const counts = await createQueryClient().fetchQuery(
      trainingStatusCountsQueryOptions({ rarity: 6, needsElite2: true }),
    )

    expect(counts).toEqual({ trainable: 2, owned: 1, all: 2 })
    expect(apiMocks.getOperatorList).toHaveBeenCalledWith(
      { status: 'trainable', rarity: 6, needsElite2: true },
      expect.any(AbortSignal),
    )
    expect(apiMocks.getOperatorList).toHaveBeenCalledWith(
      { status: 'owned', rarity: 6, needsElite2: true },
      expect.any(AbortSignal),
    )
    expect(apiMocks.getAllOperators).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(apiMocks.getOperBoxData).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('turns any failed counts read into a silent-capable query error', async () => {
    apiMocks.getOperatorList.mockResolvedValue({ success: true, data: { operators: [] } })
    apiMocks.getAllOperators.mockResolvedValue({ success: false, message: '目录服务不可用' })
    apiMocks.getOperBoxData.mockResolvedValue({ success: true, data: { data: [] } })

    const error = await createQueryClient()
      .fetchQuery(trainingStatusCountsQueryOptions({}))
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ message: '目录服务不可用' })
  })

  it('keeps the previous all count when a real refetch returns an empty catalogue', async () => {
    apiMocks.getOperatorList.mockResolvedValue({ success: true, data: { operators: [] } })
    apiMocks.getAllOperators.mockResolvedValue({
      success: true,
      data: [
        { id: 'char_a', name: 'A', rarity: 6, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
        { id: 'char_b', name: 'B', rarity: 6, profession: 'SNIPER', level: 0, elite: 0, potential: 0 },
      ],
    })
    apiMocks.getOperBoxData.mockResolvedValue({ success: true, data: { data: [] } })

    const client = createQueryClient()
    const options = trainingStatusCountsQueryOptions({})
    expect(await client.fetchQuery(options)).toEqual({ trainable: 0, owned: 0, all: 2 })

    apiMocks.getAllOperators.mockResolvedValue({ success: true, data: [] })
    await client.fetchQuery({ ...options, staleTime: 0 })

    // `fetchQuery` 返回本次原始结果；观察者读到的是 structuralSharing 合并后的缓存值。
    expect(client.getQueryData(options.queryKey)).toEqual({ trainable: 0, owned: 0, all: 2 })
  })
})
