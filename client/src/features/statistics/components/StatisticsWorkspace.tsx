/**
 * 统计数据工作区
 *
 * 跨面板状态集中在这里：
 * - 当前 tab 由 URL 查询串决定（页面链接可直达某个 tab），并决定筛选/排序等
 *   面板局部状态的生命期；
 * - 识别与材料命令只有一份投影（`useStatisticsCommands`），解析快照写回 Query；
 * - 四类资源的跨域失效订阅只建一次，各面板各自持有自己的 Query。
 *
 * 三个面板始终挂载（非当前 tab 返回 null），因此首屏四路读取的时机与
 * 迁移前一致，tab 切换不会重建 query 或丢失面板状态。
 */

import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { gameDataKeys } from '@/features/game-data'
import { useResourceInvalidation } from '@/features/resource-invalidation'
import { useStatisticsCommands } from '../hooks/useStatisticsCommands'
import { statisticsKeys } from '../model/queryKeys'
import {
  DEFAULT_STATISTICS_TAB,
  readStatisticsTab,
  STATISTICS_TAB_PARAM,
} from '../model/tabNavigation'
import DepotPanel from './DepotPanel'
import DropPanel from './DropPanel'
import OperatorPanel from './OperatorPanel'
import StatisticsTabs from './StatisticsTabs'
import type { ActiveTab } from '../types'

/** 读取由 Query 持有，失效到达后按作用域精确保废对应资源。 */
const STATISTICS_RESOURCE_SCOPES = ['depot', 'operbox', 'catalog', 'drops'] as const

export default function StatisticsWorkspace() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = readStatisticsTab(searchParams.get(STATISTICS_TAB_PARAM)) ?? DEFAULT_STATISTICS_TAB
  const command = useStatisticsCommands()

  // tab 切换只替换当前历史项，避免在浏览器历史里堆积同页的 tab 记录。
  const selectTab = useCallback((tab: ActiveTab) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (tab === DEFAULT_STATISTICS_TAB) {
        next.delete(STATISTICS_TAB_PARAM)
      } else {
        next.set(STATISTICS_TAB_PARAM, tab)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  useResourceInvalidation(STATISTICS_RESOURCE_SCOPES, ({ resources, cause, detail }) => {
    // 本页识别命令在发布前已写入权威快照；只有携带该标记的发布才跳过自身重取。
    const recognizedSnapshotWritten = cause === 'recognition'
      && typeof detail === 'object'
      && detail !== null
      && (detail as { authoritativeSnapshot?: unknown }).authoritativeSnapshot === true
    if (resources.includes('depot') && !recognizedSnapshotWritten) {
      void queryClient.invalidateQueries({ queryKey: gameDataKeys.resource('depot') })
    }
    if (resources.includes('operbox') && !recognizedSnapshotWritten) {
      void queryClient.invalidateQueries({ queryKey: gameDataKeys.resource('operbox') })
    }
    if (resources.includes('catalog')) {
      void queryClient.invalidateQueries({ queryKey: gameDataKeys.resource('catalog') })
    }
    if (resources.includes('drops')) {
      void queryClient.invalidateQueries({ queryKey: statisticsKeys.resource('drops') })
    }
  })

  return (
    <>
      <StatisticsTabs activeTab={activeTab} onTabChange={selectTab} />

      <div>
        {/* 功能卡片 */}
        <div className="min-w-0 app-stack-section">
          <OperatorPanel isActive={activeTab === 'operbox'} command={command} />
          <DepotPanel isActive={activeTab === 'depot'} command={command} />
          <DropPanel isActive={activeTab === 'drops'} />
        </div>
      </div>
    </>
  )
}
