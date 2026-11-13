import { describe, expect, it } from 'vitest'
import type { TaskFlowItem } from '../types'
import { resolveExecutionStep, taskResultsFromSummary } from './automationTaskProgress'

const task = (id: string, name: string, commandId = 'fight') => ({
  id, name, commandId, enabled: true, params: {},
}) as TaskFlowItem

describe('automation execution step mapping', () => {
  it('maps the enabled-step index past disabled tasks', () => {
    const flow = [
      { ...task('startup-1', '启动游戏', 'startup'), enabled: false },
      task('fight-1', '理智作战'),
      task('recruit-1', '自动公招', 'recruit'),
    ]

    expect(resolveExecutionStep(flow, { currentStep: 0, currentTaskId: null })).toBe(1)
    expect(resolveExecutionStep(flow, { currentStep: 1, currentTaskId: null })).toBe(2)
  })

  it('prefers the task id when the server provides it', () => {
    const flow = [task('startup-1', '启动游戏', 'startup'), task('fight-1', '理智作战'), task('recruit-1', '自动公招', 'recruit')]

    expect(resolveExecutionStep(flow, { currentStep: 0, currentTaskId: 'recruit-1' })).toBe(2)
    expect(resolveExecutionStep(flow, { currentStep: null, currentTaskId: 'missing' })).toBe(-1)
  })
})

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
