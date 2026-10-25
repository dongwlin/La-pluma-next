/**
 * 运行时状态域公开面
 * 后端连接与任务运行状态的跨页面消费入口。
 *
 * 连接健康来自后端探针；运行状态只由执行控制器的唯一快照投影，两者不互相替代。
 */

export { default as FloatingStatusIndicator } from './components/FloatingStatusIndicator'
export {
  probeBackendAvailability,
  useAutomationAvailability,
  useBackendStatusMonitor,
} from './hooks/useBackendStatusMonitor'
export { useRunStatusProjection } from './hooks/useRunStatusProjection'
export { useStatusStore } from './store/statusStore'
export { isRunStatusBusy } from './utils/runStatus'
export type { StatusMessageType } from './utils/statusMessage'
