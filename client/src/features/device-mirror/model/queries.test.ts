// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { deviceStatsQueryOptions } from './queries'
import { DEVICE_MIRROR_DOMAIN, deviceMirrorKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getDeviceStats: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

describe('device stats query options', () => {
  beforeEach(() => {
    apiMocks.getDeviceStats.mockReset()
  })

  it('scopes the device sample to the device-mirror domain', () => {
    expect(DEVICE_MIRROR_DOMAIN).toBe('device-mirror')
    expect(deviceStatsQueryOptions().queryKey).toEqual(deviceMirrorKeys.query('device-stats'))
    expect(deviceStatsQueryOptions().queryKey).toEqual(['device-mirror', 'device-stats'])
  })

  it('passes the query signal to the device endpoint', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 24, temp: 38 } })

    const data = await createQueryClient().fetchQuery(deviceStatsQueryOptions())

    expect(data).toEqual({ cpuPct: 24, temp: 38 })
    expect(apiMocks.getDeviceStats).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
  })

  it('accepts a null payload when no device is attached', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: null })

    await expect(createQueryClient().fetchQuery(deviceStatsQueryOptions())).resolves.toBeNull()
  })

  it('surfaces a failed device envelope as a query error', async () => {
    apiMocks.getDeviceStats.mockResolvedValue({ success: false, message: '设备不可用' })

    const error = await createQueryClient()
      .fetchQuery(deviceStatsQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'api', message: '设备不可用' })
  })
})
