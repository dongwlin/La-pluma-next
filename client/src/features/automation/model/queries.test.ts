// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { activityQueryOptions, scheduleExecutionQueryOptions } from './queries'
import { AUTOMATION_DOMAIN, automationKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

describe('automation query options', () => {
  beforeEach(() => {
    apiMocks.getActivity.mockReset()
    apiMocks.getScheduleExecutionStatus.mockReset()
  })

  it('scopes activity by client type and schedule execution by resource', () => {
    expect(AUTOMATION_DOMAIN).toBe('automation')
    expect(activityQueryOptions('Official').queryKey).toEqual(
      automationKeys.query('activity', 'Official'),
    )
    expect(activityQueryOptions('Bilibili').queryKey).toEqual(['automation', 'activity', 'Bilibili'])
    expect(scheduleExecutionQueryOptions().queryKey).toEqual(['automation', 'schedule-execution'])
  })

  it('passes the client type and query signal to the activity endpoint', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: true, data: { available: true, name: '测试活动' } })

    const data = await createQueryClient().fetchQuery(activityQueryOptions('Official'))

    expect(data).toEqual({ available: true, name: '测试活动' })
    expect(apiMocks.getActivity).toHaveBeenCalledWith('Official', expect.any(AbortSignal))
  })

  it('surfaces activity failures as query errors', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: false, message: '活动服务不可用' })

    const error = await createQueryClient()
      .fetchQuery(activityQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', message: '活动服务不可用' })
  })

  it('passes the query signal to the schedule execution endpoint', async () => {
    apiMocks.getScheduleExecutionStatus.mockResolvedValue({ success: true, data: { isRunning: false } })

    const data = await createQueryClient().fetchQuery(scheduleExecutionQueryOptions())

    expect(data).toEqual({ isRunning: false })
    expect(apiMocks.getScheduleExecutionStatus).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
})
