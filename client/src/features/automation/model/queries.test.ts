// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import type { AutomationActivityPayload } from './activity'
import {
  activityQueryOptions,
  infrastScheduleListQueryOptions,
  infrastScheduleQueryOptions,
  scheduleExecutionQueryOptions,
} from './queries'
import { AUTOMATION_DOMAIN, automationKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getNotificationConfig: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  listInfrastSchedules: vi.fn(),
  readInfrastSchedule: vi.fn(),
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
  rerun: false,
  activities: [],
  lastSuccessAt: 1_760_000_000_000,
  dataUpdatedAt: 1_760_000_000_000,
  failure: null,
  ...overrides,
})

describe('automation query options', () => {
  beforeEach(() => {
    apiMocks.getActivity.mockReset()
    apiMocks.getScheduleExecutionStatus.mockReset()
    apiMocks.listInfrastSchedules.mockReset()
    apiMocks.readInfrastSchedule.mockReset()
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

describe('custom infrastructure schedule queries', () => {
  beforeEach(() => {
    apiMocks.listInfrastSchedules.mockReset()
    apiMocks.readInfrastSchedule.mockReset()
  })

  it('keeps only well-formed schedule summaries from the list payload', async () => {
    apiMocks.listInfrastSchedules.mockResolvedValue({
      success: true,
      data: {
        directory: '/tmp/maa/infrast',
        schedules: [
          { name: 'base.json', title: '排班', planCount: 2, updatedAt: null, valid: true },
          { name: 'broken.json', title: '', planCount: 0, updatedAt: '2026-11-06T00:00:00.000Z', valid: false },
          { name: 3 },
        ],
      },
    })

    const data = await createQueryClient().fetchQuery(infrastScheduleListQueryOptions())

    expect(data.directory).toBe('/tmp/maa/infrast')
    expect(data.schedules.map(schedule => schedule.name)).toEqual(['base.json', 'broken.json'])
  })

  it('loads a valid schedule document and rejects an invalid one', async () => {
    apiMocks.readInfrastSchedule.mockResolvedValue({
      success: true,
      data: { name: 'base.json', document: { plans: [{ rooms: { training: [{ operatorsB: ['银灰'] }] } }] } },
    })
    const client = createQueryClient()
    const data = await client.fetchQuery(infrastScheduleQueryOptions('base.json'))
    expect(data.name).toBe('base.json')
    expect(data.document.plans).toHaveLength(1)
    expect(apiMocks.readInfrastSchedule.mock.calls[0]?.[0]).toBe('base.json')

    apiMocks.readInfrastSchedule.mockResolvedValue({
      success: true,
      data: { name: 'broken.json', document: { plans: [] } },
    })
    await expect(client.fetchQuery(infrastScheduleQueryOptions('broken.json'))).rejects.toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: 'plans 至少包含一个方案',
      kind: 'contract',
    })
  })

  it('does not request a document until a filename exists', () => {
    expect(infrastScheduleQueryOptions('').enabled).toBe(false)
    expect(infrastScheduleQueryOptions('base.json').enabled).toBe(true)
  })
})
