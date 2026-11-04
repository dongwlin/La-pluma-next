import { useQuery } from '@tanstack/react-query'
import { DEVICE_STATS_POLL_INTERVAL_MS } from '../constants'
import { deviceStatsQueryOptions } from '../model/queries'

export function useDeviceStatsSample() {
  return useQuery({
    ...deviceStatsQueryOptions(),
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchInterval: DEVICE_STATS_POLL_INTERVAL_MS,
  })
}
