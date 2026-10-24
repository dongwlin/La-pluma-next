/**
 * 自动任务域公开面
 * 公开面保持克制：仅导出页面，以及被其他域消费的调度端点。
 */

import './styles/automation.css'

export { default } from './pages/AutomationTasks'
export {
  executeScheduleNow,
  getActivity,
  getScheduleExecutionStatus,
  runCurrentActivity,
} from './api'
