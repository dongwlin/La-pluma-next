/**
 * 统计命令状态的薄订阅入口。
 *
 * 命令生命周期由模块级所有者持有，页面隐藏、Activity 清理或重挂载都不会
 * 中止等待或重建状态；页面只读取稳定快照并展示/发起操作。
 */

import { useSyncExternalStore } from 'react'
import {
  statisticsCommandOwner,
  type StatisticsCommandOwner,
  type StatisticsCommandState,
} from '../model/commandOwner'

export function useStatisticsCommandState(
  owner: StatisticsCommandOwner = statisticsCommandOwner,
): StatisticsCommandState {
  return useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
}
