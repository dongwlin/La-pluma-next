import { appTabRoute } from '@/shared/navigation'
import type { ActiveTab } from '../types'

export const DEFAULT_STATISTICS_TAB: ActiveTab = 'operbox'
export const STATISTICS_TAB_PARAM = 'tab'

const STATISTICS_TABS: readonly ActiveTab[] = ['operbox', 'depot', 'drops']

/** 只接受已知 tab；缺失、坏形状与未知值都按“没有指定”处理。 */
export function readStatisticsTab(value: unknown): ActiveTab | null {
  return STATISTICS_TABS.find(tab => tab === value) ?? null
}

/** 数据页上某个 tab 的地址；默认 tab 不带查询串，保持规范地址最短。 */
export function statisticsTabRoute(tab: ActiveTab): string {
  const route = appTabRoute('statistics')
  return tab === DEFAULT_STATISTICS_TAB ? route : `${route}?${STATISTICS_TAB_PARAM}=${tab}`
}
