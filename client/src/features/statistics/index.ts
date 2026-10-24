/**
 * 数据统计域公开面
 * 公开面保持克制：仅导出页面，以及被其他域消费的统计端点。
 */

export { default } from './pages/DataStatistics'
export {
  getItemIconUrl,
  getOpenTodayStages,
  getOperBoxData,
  getTodayDrops,
} from './api'
