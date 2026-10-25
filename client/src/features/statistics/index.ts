/**
 * 数据统计域公开面
 * 公开面保持克制：页面，以及被 Dashboard 消费的掉落/开放关卡读取。
 * 仓库、持有干员与干员目录由 `features/game-data` 统一持有。
 */

import './styles/statistics.css'

export { default } from './pages/DataStatistics'
export {
  getOpenTodayStages,
  getTodayDrops,
} from './api'
