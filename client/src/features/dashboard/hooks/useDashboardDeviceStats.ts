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
