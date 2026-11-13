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
