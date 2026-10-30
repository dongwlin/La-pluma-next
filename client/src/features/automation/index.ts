/**
 * 自动任务域公开面
 * 公开面保持克制：仅导出页面组合所需的工作区，以及被其他域消费的调度端点。
 */

import './styles/automation.css'

export { default as AutomationWorkspace } from './components/AutomationWorkspace'
export {
  executeScheduleNow,
  getActivity,
  getScheduleExecutionStatus,
  runCurrentActivity,
} from './api'
export { AUTOMATION_DOMAIN, automationKeys } from './model/queryKeys'
export {
  activityQueryOptions,
  notificationConfigQueryOptions,
  scheduleExecutionQueryOptions,
} from './model/queries'
export { normalizeActivityPayload } from './model/activity'
export {
  cloneNotificationConfig,
  emptyNotificationConfig,
  normalizeNotificationConfig,
} from './model/notificationConfig'
export type {
  NotificationConfig,
  TelegramConfig,
} from './model/notificationConfig'
export type { AutomationResource } from './model/queryKeys'
export type {
  ActivityFailure,
  ActivityStatus,
  AutomationActivityCompletion,
  AutomationActivityPayload,
} from './model/activity'
export type { AutomationScheduleExecutionPayload } from './model/queries'
