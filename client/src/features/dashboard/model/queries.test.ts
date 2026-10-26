// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { automationKeys } from '@/features/automation'
import { statisticsKeys } from '@/features/statistics'
import { trainingKeys } from '@/features/training'
import {
  dashboardSnapshotQueryOptions,
  readDashboardSnapshot,
} from './queries'
import { dashboardKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  getTrainingQueue: vi.fn(),
  getTodayDrops: vi.fn(),
  getOpenTodayStages: vi.fn(),
}))

vi.mock('@/features/automation/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/automation/api')>()
  return {
    ...actual,
    getActivity: apiMocks.getActivity,
    getScheduleExecutionStatus: apiMocks.getScheduleExecutionStatus,
  }
})

vi.mock('@/features/training/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/training/api')>()
  return { ...actual, getTrainingQueue: apiMocks.getTrainingQueue }
})

vi.mock('@/features/statistics/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/statistics/api')>()
  return {
    ...actual,
    getTodayDrops: apiMocks.getTodayDrops,
    getOpenTodayStages: apiMocks.getOpenTodayStages,
  }
})

const ok = (data: unknown) => ({ success: true, data })

const resolveAllFive = () => {
  apiMocks.getActivity.mockResolvedValue(ok({ available: true, name: '测试活动' }))
  apiMocks.getScheduleExecutionStatus.mockResolvedValue(ok({ isRunning: false }))
  apiMocks.getTrainingQueue.mockResolvedValue(ok({ queue: [{ operatorName: '能天使' }] }))
  apiMocks.getTodayDrops.mockResolvedValue(ok([{ stageName: '1-7', drops: [{ name: '固源岩', count: 4 }] }]))
  apiMocks.getOpenTodayStages.mockResolvedValue(ok({
    open: [{ stage: 'AP-5', name: '采购凭证' }],
    closed: [],
  }))
}

describe('dashboard snapshot queries', () => {
  beforeEach(() => {
    apiMocks.getActivity.mockReset()
    apiMocks.getScheduleExecutionStatus.mockReset()
    apiMocks.getTrainingQueue.mockReset()
    apiMocks.getTodayDrops.mockReset()
    apiMocks.getOpenTodayStages.mockReset()
  })

  it('scopes the coordinated snapshot to the dashboard domain without retaining it', () => {
    expect(dashboardKeys.query('snapshot')).toEqual(['dashboard', 'snapshot'])
    expect(dashboardSnapshotQueryOptions()).toMatchObject({
      queryKey: ['dashboard', 'snapshot'],
      staleTime: 0,
      gcTime: 0,
      retry: false,
    })
  })

  it('reads the five domain resources through their own query keys', async () => {
    resolveAllFive()
    const client = createQueryClient()

    const snapshot = await readDashboardSnapshot(client)

    expect(snapshot?.activitySummary.name).toBe('测试活动')
    expect(snapshot?.trainingSummary).toEqual({ count: 1, topNames: ['能天使'] })
    expect(apiMocks.getActivity).toHaveBeenCalledWith('Official', expect.any(AbortSignal))
    expect(apiMocks.getScheduleExecutionStatus).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(apiMocks.getTrainingQueue).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(apiMocks.getTodayDrops).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(apiMocks.getOpenTodayStages).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(client.getQueryData(automationKeys.query('activity', 'Official'))).toEqual({
      available: true,
      name: '测试活动',
    })
    expect(client.getQueryData(automationKeys.query('schedule-execution'))).toEqual({ isRunning: false })
    expect(client.getQueryData(trainingKeys.resource('queue'))).toEqual({ queue: [{ operatorName: '能天使' }] })
    expect(client.getQueryData(statisticsKeys.query('today-drops'))).toBeDefined()
    expect(client.getQueryData(statisticsKeys.query('open-stages'))).toBeDefined()
  })

  it('always rereads all five resources for a new snapshot', async () => {
    resolveAllFive()
    const client = createQueryClient()

    await readDashboardSnapshot(client)
    await readDashboardSnapshot(client)

    expect(apiMocks.getActivity).toHaveBeenCalledTimes(2)
    expect(apiMocks.getScheduleExecutionStatus).toHaveBeenCalledTimes(2)
    expect(apiMocks.getTrainingQueue).toHaveBeenCalledTimes(2)
    expect(apiMocks.getTodayDrops).toHaveBeenCalledTimes(2)
    expect(apiMocks.getOpenTodayStages).toHaveBeenCalledTimes(2)
  })

  it('fails the whole snapshot when one resource fails', async () => {
    resolveAllFive()
    apiMocks.getTodayDrops.mockResolvedValue({ success: false, message: '掉落服务不可用' })

    const error = await readDashboardSnapshot(createQueryClient()).catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', message: '掉落服务不可用' })
    expect(apiMocks.getTodayDrops).toHaveBeenCalledTimes(1)
  })

  it('fails the whole snapshot when a successful payload has an invalid shape', async () => {
    resolveAllFive()
    apiMocks.getActivity.mockResolvedValue(ok({
      available: true,
      name: '格式异常活动',
      completion: { totalStages: 1.5 },
    }))

    const error = await readDashboardSnapshot(createQueryClient()).catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      kind: 'contract',
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '总览快照数据格式不正确',
    })
  })

  it('does not inherit the global retry policy for a snapshot read', async () => {
    apiMocks.getActivity.mockRejectedValueOnce(new Error('网络中断'))
    apiMocks.getScheduleExecutionStatus.mockResolvedValue(ok({ isRunning: false }))
    apiMocks.getTrainingQueue.mockResolvedValue(ok({ queue: [] }))
    apiMocks.getTodayDrops.mockResolvedValue(ok([]))
    apiMocks.getOpenTodayStages.mockResolvedValue(ok({ open: [], closed: [] }))

    await expect(readDashboardSnapshot(createQueryClient())).rejects.toThrow('网络中断')

    expect(apiMocks.getActivity).toHaveBeenCalledTimes(1)
  })
})
