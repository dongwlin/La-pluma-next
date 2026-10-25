/**
 * 干员培养域公开面
 * 公开面保持克制：页面，以及被其他域消费的养成命令/队列读取。
 * 全量干员目录、仓库与持有干员由 `features/game-data` 统一持有。
 */

import './styles/training.css'

export { default } from './pages/OperatorTraining'
export {
  fetchOperatorMaterials,
  generateTrainingPlan,
  getTrainingQueue,
} from './api'
