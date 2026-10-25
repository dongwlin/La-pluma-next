/**
 * 执行控制器的薄订阅入口。
 *
 * 页面只订阅稳定快照并展示/发起操作；观察循环由应用组装层通过
 * useExecutionObservation 启动，不随页面或 Activity 的挂载状态创建第二份。
 */

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
