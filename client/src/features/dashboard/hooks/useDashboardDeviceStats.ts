/**
 * 总览设备采样投影
 *
 * 采样本身由 device-mirror 的 `useDeviceStatsSample` 持有（5s 轮询、失败保旧、
 * Activity 恢复立即采样）。本 hook 只把每次成功采样的原始记录交给
 * `dashboardStore`：store 负责百分比/有限数值等语义校验、温度历史与
 * 随完整快照一起持久化。`dataUpdatedAt` 变化时追加一次温度样本，即使
 * 采样值完全相同也不会丢点；失败时它不变，因此不会重复追加。
 */

import { useEffect } from 'react'
import { useDeviceStatsSample } from '@/features/device-mirror'
import { useDashboardStore } from '../store/dashboardStore'

export function useDashboardDeviceStats() {
  const { data, dataUpdatedAt } = useDeviceStatsSample()

  useEffect(() => {
    if (data == null) return
    useDashboardStore.getState().updateDeviceStats(data)
  }, [data, dataUpdatedAt])
}
