// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('passes the client type to the activity endpoint', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: true, data: { available: true, name: '测试活动' } })

    const data = await createQueryClient().fetchQuery(activityQueryOptions('Official'))

    expect(data).toEqual({ available: true, name: '测试活动' })
    expect(apiMocks.getActivity.mock.calls[0]?.[0]).toBe('Official')
  })
})
