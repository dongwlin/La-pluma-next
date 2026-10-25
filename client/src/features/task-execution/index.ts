/**
 * 任务执行微域公开面
 * 跨域共用的命令执行、Run 观察与目标停止端点，以及应用级执行控制器。
 */

export {
  executeCommand,
  executePredefinedTask,
  executePredefinedTaskArgs,
  getRun,
  getRunSnapshot,
  getTaskStatus,
  stopRun,
  stopTask,
} from './api'
export type { AgentRequestOptions, TaskConfig } from './api'

export {
  executionController,
} from './controller/executionController'
export type {
  ExecutionControllerState,
  ExecutionIdentityState,
  ExecutionIntent,
  ExecutionObservationPhase,
  ExecutionSubmissionState,
} from './controller/executionController'

export { useExecutionObservation, useExecutionSnapshot } from './hooks/useExecutionController'

export {
  ACTIVE_RUN_STATES,
  TERMINAL_RUN_STATES,
  findRunById,
  isActiveRunState,
  isTerminalRunState,
  readSubmittedRun,
  readSubmittedRunId,
} from './types'
export type {
  ActiveRunState,
  AgentRun,
  RunError,
  RunLease,
  RunLeaseOwner,
  RunLinks,
  RunOccupancy,
  RunOccupancyState,
  RunProgress,
  RunRecovery,
  RunSnapshot,
  RunState,
  RunSubmissionData,
  RunTaskResult,
  ScheduleExecutionSnapshot,
  StopRunResult,
  TerminalRunState,
} from './types'
