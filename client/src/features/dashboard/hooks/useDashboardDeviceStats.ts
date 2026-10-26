/**
 * 总览设备采样投影
 *
 * 采样本身由 device-mirror 的 `useDeviceStatsSample` 持有（5s 轮询、失败保旧、
 * Activity 恢复立即采样）。本 hook 只把每次成功采样连同 `dataUpdatedAt`
 * 交给 `dashboardStore`：store 负责百分比/有限数值等语义校验、温度历史与
 * 随完整快照一起持久化。
 *
 * 采样时间同时作为样本身份：Activity 隐藏清理 Effects、恢复重跑时，缓存里
 * 的同一份样本不会再次追加温度点；只有新的 `dataUpdatedAt` 才会追加（即使
 * 数值相同也不丢点）。
 */

import { useEffect } from 'react'
import { useDeviceStatsSample } from '@/features/device-mirror'
import { useDashboardStore } from '../store/dashboardStore'

export function useDashboardDeviceStats() {
  const { data, dataUpdatedAt } = useDeviceStatsSample()

  useEffect(() => {
    if (data == null) return
    useDashboardStore.getState().updateDeviceStats(data, dataUpdatedAt)
  }, [data, dataUpdatedAt])
}
