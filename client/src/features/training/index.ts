/**
 * 干员培养域公开面
 * 公开面保持克制：页面工作区，以及被其他域消费的养成命令/队列读取。
 * 全量干员目录、仓库与持有干员由 `features/game-data` 统一持有。
 */

import './styles/training.css'

export { default as TrainingWorkspace } from './components/TrainingWorkspace'
export {
  fetchOperatorMaterials,
  generateTrainingPlan,
  getTrainingQueue,
} from './api'
export { TRAINING_DOMAIN, trainingKeys } from './model/queryKeys'
export {
  trainingCandidatesQueryOptions,
  trainingQueueQueryOptions,
  trainingStatusCountsQueryOptions,
} from './model/queries'
export type { TrainingResource } from './model/queryKeys'
export type { TrainingCandidateFilters } from './model/candidates'
export type { TrainingStatusCountsFilters } from './model/queries'
export type {
  TrainingFlowSync,
  TrainingQueueSnapshot,
  TrainingStatusCounts,
} from './types'
