/**
 * 投屏/截图预览域只读资源 Query 定义
 *
 * 设备采样是独立于总览业务快照的轮询资源：失败静默保留上一份样本，
 * 不参与五路业务快照的有效性判定，也不写入总览的持久化缓存。
 */

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
