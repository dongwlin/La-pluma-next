/**
 * 设备采样轮询入口
 *
 * 观察者随页面 Activity 隐藏/卸载注销，Query 会清理轮询计时器；恢复时
 * `refetchOnMount: 'always'` 立即采样一次，再按 5s 间隔继续。失败不展示
 * 错误、由 Query 保留上一份成功样本；轮询本身已按 5s 重试，不叠加默认
 * Query 重试。文档隐藏时 Query 暂停后台轮询（`refetchIntervalInBackground`
 * 保持默认 false）。
 */

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
