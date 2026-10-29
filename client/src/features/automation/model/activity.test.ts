// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { normalizeActivityPayload, type AutomationActivityPayload } from './activity'

const realActivity = (overrides: Partial<AutomationActivityPayload> = {}): AutomationActivityPayload => ({
  status: 'active',
  clientType: 'Official',
  available: true,
  message: '当前活动: 昨日海',
  code: 'YW',
  name: '昨日海',
  source: 'maa',
  startTime: null,
  endTime: null,
  stages: [],
  lastSuccessAt: 1_760_000_000_000,
  dataUpdatedAt: 1_760_000_000_000,
  failure: null,
  completion: {
    known: true,
    complete: false,
    completedStages: ['YW-1'],
    totalStages: 3,
    source: 'local-activity-progress',
  },
  ...overrides,
})

describe('normalizeActivityPayload', () => {
  it('accepts the real activity DTO and keeps nullable fields nullable', () => {
    const normalized = normalizeActivityPayload(realActivity())

    expect(normalized).toEqual(realActivity())
  })

  it('preserves null code, name, and source without inventing values', () => {
    const normalized = normalizeActivityPayload(realActivity({
      status: 'none',
      available: false,
      code: null,
      name: null,
      source: null,
      message: '当前没有刷关活动',
      completion: undefined,
    }))

    expect(normalized).toMatchObject({
      status: 'none',
      available: false,
      code: null,
      name: null,
      source: null,
      message: '当前没有刷关活动',
    })
    expect(normalized?.completion).toBeUndefined()
  })

  it('keeps a failure reason from an unavailable source', () => {
    const failure = { source: 'maa', message: 'MAA 活动查询失败: 超时' }
    const normalized = normalizeActivityPayload(realActivity({
      status: 'unavailable',
      available: false,
      code: null,
      name: null,
      source: null,
      message: '无法获取活动信息: MAA 活动查询失败: 超时',
      lastSuccessAt: null,
      dataUpdatedAt: null,
      failure,
      completion: undefined,
    }))

    expect(normalized?.failure).toEqual(failure)
    expect(normalized?.lastSuccessAt).toBeNull()
    expect(normalized?.dataUpdatedAt).toBeNull()
  })

  it.each<[string, unknown]>([
    ['value is not an object', 'not-an-object'],
    ['status is unknown', realActivity({ status: 'running' as AutomationActivityPayload['status'] })],
    ['client type is missing', { ...realActivity(), clientType: undefined }],
    ['message is missing', { ...realActivity(), message: undefined }],
    ['available is not boolean', { ...realActivity(), available: 'yes' }],
    ['code is undefined', { ...realActivity(), code: undefined }],
    ['start time is negative', realActivity({ startTime: -1 })],
    ['end time is fractional', realActivity({ endTime: 1.5 })],
    ['last success time is negative', realActivity({ lastSuccessAt: -1 })],
    ['data update time is fractional', realActivity({ dataUpdatedAt: 1.5 })],
    ['stages contain a non-string', { ...realActivity(), stages: ['YW-1', 2] }],
    ['stages exceed the bound', { ...realActivity(), stages: Array.from({ length: 501 }, () => 'YW-1') }],
    ['failure has no source', realActivity({ failure: { source: '', message: 'x' } })],
    ['failure has no message', { ...realActivity(), failure: { source: 'maa' } }],
    ['completion total is fractional', realActivity({
      completion: { known: true, totalStages: 1.5 },
    })],
    ['completion stages contain a non-string', { ...realActivity(), completion: { completedStages: ['YW-1', 2] } }],
    ['completion known is not boolean', { ...realActivity(), completion: { known: 'yes' } }],
  ])('returns null when %s', (_label, value) => {
    expect(normalizeActivityPayload(value)).toBeNull()
  })
})
