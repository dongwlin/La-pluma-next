// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import type { AutomationActivityPayload } from './activity'
import { activityQueryOptions, scheduleExecutionQueryOptions } from './queries'
import { AUTOMATION_DOMAIN, automationKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

const activityDto = (overrides: Partial<AutomationActivityPayload> = {}): AutomationActivityPayload => ({
  status: 'active',
  clientType: 'Official',
  available: true,
  message: '当前活动: 测试活动',
  code: 'TEST',
  name: '测试活动',
  source: 'maa',
  startTime: null,
  endTime: null,
  stages: [],
  lastSuccessAt: 1_760_000_000_000,
  dataUpdatedAt: 1_760_000_000_000,
  failure: null,
  ...overrides,
})

describe('automation query options', () => {
  beforeEach(() => {
    apiMocks.getActivity.mockReset()
    apiMocks.getScheduleExecutionStatus.mockReset()
  })

  it('uses a profile sentinel when the client type is omitted', () => {
    expect(AUTOMATION_DOMAIN).toBe('automation')
    expect(activityQueryOptions()).toMatchObject({
      queryKey: ['automation', 'activity', 'profile'],
    })
    expect(activityQueryOptions('Bilibili').queryKey).toEqual(['automation', 'activity', 'Bilibili'])
    expect(scheduleExecutionQueryOptions().queryKey).toEqual(['automation', 'schedule-execution'])
  })

  it('passes an explicit client type to the activity endpoint', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: true, data: activityDto() })

    const data = await createQueryClient().fetchQuery(activityQueryOptions('Official'))

    expect(data).toEqual(activityDto())
    expect(apiMocks.getActivity.mock.calls[0]?.[0]).toBe('Official')
  })

  it('lets the server resolve the profile client type when no override is given', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: true, data: activityDto({ clientType: 'Bilibili' }) })

    const data = await createQueryClient().fetchQuery(activityQueryOptions())

    expect(data.clientType).toBe('Bilibili')
    expect(apiMocks.getActivity.mock.calls[0]?.[0]).toBeUndefined()
  })

  it('rejects a payload that does not match the activity DTO', async () => {
    apiMocks.getActivity.mockResolvedValue({
      success: true,
      data: { available: true, name: '缺少状态的旧载荷' },
    })

    await expect(createQueryClient().fetchQuery(activityQueryOptions())).rejects.toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '活动信息格式不正确',
      kind: 'contract',
    })
  })

  it('keeps the schedule execution key unchanged', () => {
    expect(scheduleExecutionQueryOptions().queryKey).toEqual(automationKeys.query('schedule-execution'))
    expect(activityQueryOptions().queryKey).not.toEqual(automationKeys.query('schedule-execution'))
  })

  it('throws an ApiRequestError for contract failures', async () => {
    apiMocks.getActivity.mockResolvedValue({ success: true, data: null })

    const error = await createQueryClient().fetchQuery(activityQueryOptions()).catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'contract', code: 'INVALID_DOMAIN_PAYLOAD' })
  })
})
