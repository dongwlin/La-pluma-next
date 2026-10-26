/**
 * 数据统计域公开面
 * 公开面保持克制：页面、被 Dashboard 消费的掉落/开放关卡读取，以及统计 query 定义。
 * 仓库、持有干员与干员目录由 `features/game-data` 统一持有；识别/材料命令所有者
 * 由本域页面与后续统计面板在域内相对导入，不对外暴露为跨域命令入口。
 */

import './styles/statistics.css'

export { default } from './pages/DataStatistics'
export {
  getOpenTodayStages,
  getTodayDrops,
} from './api'
export { STATISTICS_DOMAIN, statisticsKeys } from './model/queryKeys'
export {
  dropStatisticsQueryOptions,
  openTodayStagesQueryOptions,
  todayDropsQueryOptions,
} from './model/queries'
export type { StatisticsResource } from './model/queryKeys'
export type {
  OpenTodayStagesPayload,
  TodayDropsPayload,
} from './model/queries'
