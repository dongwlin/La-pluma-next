/**
 * 干员培养域公开面
 * 公开面保持克制：仅导出页面，以及被其他域消费的养成端点。
 */

export { default } from './pages/OperatorTraining'
export {
  fetchOperatorMaterials,
  generateTrainingPlan,
  getAllOperators,
  getTrainingQueue,
} from './api'
