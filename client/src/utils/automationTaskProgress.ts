import type { TaskFlowItem } from '../types/components'

export type TaskExecutionState = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped'

export interface TaskExecutionResult {
  taskId: string
  task: string
  status: TaskExecutionState
}

interface ProgressSummary {
  taskResults?: TaskExecutionResult[]
  actions?: Array<{ task: string; status: 'success' | 'failed' | 'skipped' }>
  errors?: Array<string | { task: string; error: string }>
}

// Older servers only return action names. Avoid assigning ambiguous results to duplicate tasks.
export function taskResultsFromSummary(summary: ProgressSummary, tasks: TaskFlowItem[]): TaskExecutionResult[] {
  if (Array.isArray(summary.taskResults)) return summary.taskResults
  return tasks.filter(task => task.enabled).flatMap(task => {
    if (tasks.filter(other => other.name === task.name).length !== 1) return []
    const actions = summary.actions?.filter(action => action.task === task.name
      || ((task.commandId || task.id.split('-')[0]) === 'fight' && action.task.startsWith(`${task.name} (`))) || []
    const failed = summary.errors?.some(error => typeof error !== 'string' && error.task === task.name)
      || actions.some(action => action.status === 'failed')
    const status = failed ? 'failed' : actions.some(action => action.status === 'success') ? 'success'
      : actions.some(action => action.status === 'skipped') ? 'skipped' : null
    return status ? [{ taskId: task.id, task: task.name, status }] : []
  })
}
