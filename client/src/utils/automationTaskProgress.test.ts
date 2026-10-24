import { describe, expect, it } from 'vitest'
import type { TaskFlowItem } from '@/shared/types/components'
import { taskResultsFromSummary } from './automationTaskProgress'

const task = (id: string, name: string, commandId = 'fight') => ({
  id, name, commandId, enabled: true, params: {},
}) as TaskFlowItem

describe('automation task results', () => {
  it('keeps task ids authoritative for repeated tasks and mixed action outcomes', () => {
    const tasks = [task('fight-1', '理智作战'), task('fight-2', '理智作战')]
    expect(taskResultsFromSummary({
      taskResults: [
        { taskId: 'fight-1', task: '理智作战', status: 'success' },
        { taskId: 'fight-2', task: '理智作战', status: 'failed' },
      ],
    }, tasks).map(result => result.status)).toEqual(['success', 'failed'])
  })

  it('restores legacy multi-stage fight and Award results without treating skipped sub-actions as a task failure', () => {
    expect(taskResultsFromSummary({ actions: [
      { task: '理智作战 (1-7)', status: 'success' },
      { task: '理智作战 (CE-6)', status: 'skipped' },
      { task: '领取奖励', status: 'success' },
      { task: '领取奖励', status: 'skipped' },
    ] }, [task('fight-1', '理智作战'), task('award-1', '领取奖励', 'award')])
      .map(result => result.status)).toEqual(['success', 'success'])
  })

  it('does not guess which repeated legacy task ran or mark missing results completed', () => {
    expect(taskResultsFromSummary({ actions: [{ task: '理智作战', status: 'success' }] }, [
      task('fight-1', '理智作战'), task('fight-2', '理智作战'), task('award-1', '领取奖励', 'award'),
    ])).toEqual([])
  })

  it('preserves failures and never assigns old results to a different task id', () => {
    expect(taskResultsFromSummary({ actions: [
      { task: '理智作战 (1-7)', status: 'success' },
      { task: '理智作战 (CE-6)', status: 'failed' },
    ] }, [task('fight-1', '理智作战')])[0]?.status).toBe('failed')
    expect(taskResultsFromSummary({ taskResults: [] }, [task('new', '理智作战')])).toEqual([])
  })
})
