import { queryOptions } from '@tanstack/react-query'
import { unwrapApiResponse } from '@/shared/api'
import { getDeviceStats } from '../api'
import { deviceMirrorKeys } from './queryKeys'

/** 设备端点的原始记录；字段语义由总览投影在写入 store 前校验。 */
export type DeviceStatsPayload = Record<string, unknown> | null

export const deviceStatsQueryOptions = () => queryOptions({
  queryKey: deviceMirrorKeys.query('device-stats'),
  queryFn: async ({ signal }): Promise<DeviceStatsPayload> => (
    unwrapApiResponse<DeviceStatsPayload>(await getDeviceStats(undefined, signal))
  ),
})
