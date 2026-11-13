import { describe, expect, it } from 'vitest'
import type { TaskFlowItem } from '../types'
import {
  describeFlowTaskExecutionState,
  resolveFlowTaskExecutionState,
  selectFlowCurrentStep,
  selectFlowDisplaySummary,
  selectFlowTaskResults,
} from './flowExecution'

const task = (id: string, overrides: Partial<TaskFlowItem> = {}): TaskFlowItem => ({
  id,
  commandId: 'fight',
  name: id,
  icon: null,
  description: '',
  defaultParams: {},
  paramFields: [],
  params: {},
  enabled: true,
  ...overrides,
})

const view = (overrides: Partial<{
  isRunning: boolean
  taskResults: ReturnType<typeof selectFlowTaskResults>
  currentStep: number
}> = {}) => ({
  isRunning: true,
  taskResults: [],
  currentStep: 0,
  ...overrides,
})

describe('flow execution projection', () => {
  it('prefers the owned run summary and hides the schedule fallback while busy', () => {
    const owned = { successCount: 1 }
    const schedule = { successCount: 2 }

    expect(selectFlowDisplaySummary({
      summary: owned,
      scheduleSummary: schedule,
      isRunning: false,
      isSubmitting: false,
    })).toBe(owned)
    expect(selectFlowDisplaySummary({
      summary: null,
      scheduleSummary: schedule,
      isRunning: false,
      isSubmitting: false,
    })).toBe(schedule)
    expect(selectFlowDisplaySummary({
      summary: null,
      scheduleSummary: schedule,
      isRunning: true,
      isSubmitting: false,
    })).toBeNull()
    expect(selectFlowDisplaySummary({
      summary: null,
      scheduleSummary: schedule,
      isRunning: false,
      isSubmitting: true,
    })).toBeNull()
  })

  it('reads per-task results from the live run, then the terminal summary', () => {
    const flow = [task('a'), task('b', { enabled: false }), task('c')]
    const live = [{ taskId: 'a', task: 'a', status: 'success' as const }]

    expect(selectFlowTaskResults(flow, {
      isRunning: true,
      isSubmitting: false,
      progress: { taskResults: live },
      displaySummary: null,
    })).toEqual(live)

    expect(selectFlowTaskResults(flow, {
      isRunning: false,
      isSubmitting: true,
      progress: { taskResults: live },
      displaySummary: { taskResults: [] },
    })).toEqual([])

    expect(selectFlowTaskResults(flow, {
      isRunning: false,
      isSubmitting: false,
      progress: null,
      displaySummary: {
        actions: [{ task: 'a', status: 'success' }, { task: 'c', status: 'failed' }],
      },
    })).toEqual([
      { taskId: 'a', task: 'a', status: 'success' },
      { taskId: 'c', task: 'c', status: 'failed' },
    ])
  })

  it('maps the current step by task id and only while running', () => {
    const flow = [task('a'), task('b'), task('c')]

    expect(selectFlowCurrentStep(flow, { currentStep: 1, currentTaskId: 'c' }, true)).toBe(2)
    expect(selectFlowCurrentStep(flow, { currentStep: 1, currentTaskId: null }, true)).toBe(1)
    expect(selectFlowCurrentStep(flow, { currentStep: 1, currentTaskId: 'c' }, false)).toBe(-1)
    expect(selectFlowCurrentStep(flow, null, true)).toBe(-1)
  })

  it('derives per-task states from results before step inference', () => {
    expect(resolveFlowTaskExecutionState(task('a', { enabled: false }), 0, view())).toBe('idle')
    expect(resolveFlowTaskExecutionState(task('a'), 0, view({
      taskResults: [{ taskId: 'a', task: 'a', status: 'success' }],
    }))).toBe('success')
    expect(resolveFlowTaskExecutionState(task('a'), 0, view({
      isRunning: false,
      taskResults: [{ taskId: 'a', task: 'a', status: 'running' }],
    }))).toBe('stopped')
    expect(resolveFlowTaskExecutionState(task('a'), 0, view({ currentStep: 0 }))).toBe('running')
    expect(resolveFlowTaskExecutionState(task('b'), 1, view({ currentStep: 2 }))).toBe('success')
    expect(resolveFlowTaskExecutionState(task('c'), 2, view({ currentStep: 1 }))).toBe('pending')
    expect(resolveFlowTaskExecutionState(task('c'), 2, view({
      isRunning: false,
      currentStep: 1,
    }))).toBe('idle')
  })

  it('labels the pending state differently for running and idle flows', () => {
    expect(describeFlowTaskExecutionState('pending', true)).toBe('等待执行')
    expect(describeFlowTaskExecutionState('pending', false)).toBe('未执行')
    expect(describeFlowTaskExecutionState('idle', true)).toBe('')
    expect(describeFlowTaskExecutionState('running', true)).toBe('正在执行')
    expect(describeFlowTaskExecutionState('success', false)).toBe('已完成')
    expect(describeFlowTaskExecutionState('failed', false)).toBe('执行失败')
    expect(describeFlowTaskExecutionState('skipped', false)).toBe('已跳过')
    expect(describeFlowTaskExecutionState('stopped', false)).toBe('已终止')
  })
})
