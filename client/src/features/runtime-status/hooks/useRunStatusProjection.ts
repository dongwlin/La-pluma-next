/**
 * 全局运行状态投影
 *
 * 应用级调用一次：在 React 树外订阅执行控制器，把唯一快照投影进 statusStore。
 * 页面隐藏、Activity 清理和订阅组件卸载都不影响它；页面、连接监测器与指示器
 * 不再各自写运行字段，也不再从 `tasks/status` 推断运行状态。
 */

import { useEffect } from 'react'
import {
  executionController,
  summarizeRunStatus,
  type ExecutionController,
} from '@/features/task-execution'
import { useStatusStore } from '../store/statusStore'

export function useRunStatusProjection(
  controller: ExecutionController = executionController,
): void {
  useEffect(() => {
    const apply = () => {
      useStatusStore.getState().applyRunStatus(summarizeRunStatus(controller.getState()))
    }

    apply()
    return controller.subscribe(apply)
  }, [controller])
}
