/**
 * 运行时状态域公开面
 * 后端连接与任务运行状态的跨页面消费入口。
 */

export { default as FloatingStatusIndicator } from './components/FloatingStatusIndicator'
export {
  probeBackendAvailability,
  useAutomationAvailability,
  useBackendStatusMonitor,
} from './hooks/useBackendStatusMonitor'
export { useStatusStore } from './store/statusStore'
export type { StatusMessageType } from './utils/statusMessage'
