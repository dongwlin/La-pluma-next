import { useEffect, useSyncExternalStore } from 'react'
import {
  executionController,
  type ExecutionController,
  type ExecutionControllerState,
} from '../controller/executionController'

export function useExecutionSnapshot(
  controller: ExecutionController = executionController,
): ExecutionControllerState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
}

/**
 * 启动应用级观察循环，并在应用卸载时只停止本地观察（不发送停止请求）。
 */
export function useExecutionObservation(
  controller: ExecutionController = executionController,
): void {
  useEffect(() => controller.start(), [controller])
}
