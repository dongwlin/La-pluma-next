import './styles/statistics.css'

export { default as StatisticsWorkspace } from './components/StatisticsWorkspace'
export { statisticsTabRoute } from './model/tabNavigation'
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
