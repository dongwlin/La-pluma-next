import './styles/automation.css'

export { default as AutomationWorkspace } from './components/AutomationWorkspace'
export {
  executeScheduleNow,
  getActivity,
  getScheduleExecutionStatus,
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
