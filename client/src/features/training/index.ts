import './styles/training.css'

export { default as OperatorSelectModal } from './components/OperatorSelectModal'
export { default as TrainingWorkspace } from './components/TrainingWorkspace'
export type { OperatorSelectModalProps } from './components/OperatorSelectModal'
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
  OperatorPickerOption,
  TrainingFlowSync,
  TrainingQueueSnapshot,
  TrainingStatusCounts,
} from './types'
