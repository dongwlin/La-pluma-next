/**
 * 总览完整业务快照的组合读取
 *
 * 五路资源仍由各自领域 Query 持有：activity 与 schedule-execution 归
 * `automation`，queue 归 `training`，today-drops 与 open-stages 归
 * `statistics`。本模块只做一次协调读取，不把任一查询的逐块结果直接写入
 * `dashboardStore`；只有五路都 fulfilled 且载荷归一成功才返回完整快照。
 *
 * 每路读取都显式 `staleTime: 0` 且不叠加自动重试：总览的周期刷新与失效
 * 入口本身就是重试路径，单路失败时保留上一份完整快照，避免半份数据展示。
 */

import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/shared/api'
import { activityQueryOptions, scheduleExecutionQueryOptions } from '@/features/automation'
import {
  openTodayStagesQueryOptions,
  todayDropsQueryOptions,
} from '@/features/statistics'
import { trainingQueueQueryOptions } from '@/features/training'
import { dashboardKeys } from './queryKeys'
import { normalizeDashboardSnapshot, type DashboardBusinessSnapshot } from './snapshot'

const SNAPSHOT_READ_OPTIONS = {
  staleTime: 0,
  retry: false,
} as const

const unwrapSettled = <T,>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'fulfilled') return result.value
  throw result.reason
}

const invalidSnapshotError = () => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message: '总览快照数据格式不正确',
  retryable: false,
})

/**
 * 并发读取五路业务资源并归一。任一路失败或形状不符都抛出错误，
 * 调用方不得提交部分结果。
 */
export async function readDashboardSnapshot(
  client: QueryClient,
): Promise<DashboardBusinessSnapshot> {
  const results = await Promise.allSettled([
    client.fetchQuery({ ...activityQueryOptions(), ...SNAPSHOT_READ_OPTIONS }),
    client.fetchQuery({ ...scheduleExecutionQueryOptions(), ...SNAPSHOT_READ_OPTIONS }),
    client.fetchQuery({ ...trainingQueueQueryOptions(), ...SNAPSHOT_READ_OPTIONS }),
    client.fetchQuery({ ...todayDropsQueryOptions(), ...SNAPSHOT_READ_OPTIONS }),
    client.fetchQuery({ ...openTodayStagesQueryOptions(), ...SNAPSHOT_READ_OPTIONS }),
  ])

  const [activity, scheduleExecution, trainingQueue, todayDrops, openTodayStages] = results
  const snapshot = normalizeDashboardSnapshot({
    activity: unwrapSettled(activity),
    scheduleExecution: unwrapSettled(scheduleExecution),
    trainingQueue: unwrapSettled(trainingQueue),
    todayDrops: unwrapSettled(todayDrops),
    openTodayStages: unwrapSettled(openTodayStages),
  })

  if (!snapshot) throw invalidSnapshotError()
  return snapshot
}

/**
 * 协调读取入口。`gcTime: 0` 表示快照不留在 Query 缓存中等待复用：
 * 查询只保证同一时刻最多一次协调读取，成功后立即由 `dashboardStore`
 * 原子提交；`dashboardStore` 仍是唯一展示与持久化来源。
 */
export const dashboardSnapshotQueryOptions = () => queryOptions({
  queryKey: dashboardKeys.query('snapshot'),
  queryFn: ({ client }) => readDashboardSnapshot(client),
  staleTime: 0,
  gcTime: 0,
  retry: false,
})
