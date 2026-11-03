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
