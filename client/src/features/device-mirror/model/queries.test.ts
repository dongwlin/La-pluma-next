// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { deviceStatsQueryOptions } from './queries'
import { DEVICE_MIRROR_DOMAIN, deviceMirrorKeys } from './queryKeys'

describe('device stats query options', () => {
  it('scopes the device sample to the device-mirror domain', () => {
    expect(DEVICE_MIRROR_DOMAIN).toBe('device-mirror')
    expect(deviceStatsQueryOptions().queryKey).toEqual(deviceMirrorKeys.query('device-stats'))
    expect(deviceStatsQueryOptions().queryKey).toEqual(['device-mirror', 'device-stats'])
  })
})
