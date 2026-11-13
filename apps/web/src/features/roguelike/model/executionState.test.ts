import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import { describeRoguelikeTerminalRun, projectRoguelikeStopState } from './executionState'

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'running',
    links: { self: '/api/agent/runs/run-1' },
    ...overrides,
  }
}

const STOP_INTENT = {
  mode: 'after-combat' as const,
  requestedAt: '2026-10-25T00:00:00.000Z',
  deadline: '2026-10-25T00:10:00.000Z',
  combat: true,
}

const IDLE_INPUT = {
  run: null,
  hasActiveRun: false,
  acceptedWait: false,
  requestedMode: null,
  stopAcknowledged: false,
}

describe('roguelike stop projection', () => {
  it('stays out of both stop states without an active run', () => {
    expect(projectRoguelikeStopState(IDLE_INPUT)).toEqual({
      isWaitingForCombat: false,
      isStopping: false,
    })
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun({ state: 'succeeded' }),
      acceptedWait: true,
      stopAcknowledged: true,
    })).toEqual({ isWaitingForCombat: false, isStopping: false })
  })

  it('keeps a plain active run out of the stop states', () => {
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun(),
      hasActiveRun: true,
    })).toEqual({ isWaitingForCombat: false, isStopping: false })
  })

  it('enters the wait state from the run progress stop intent', () => {
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun({ progress: { stopIntent: STOP_INTENT } }),
      hasActiveRun: true,
    })).toEqual({ isWaitingForCombat: true, isStopping: false })
  })

  it('enters the wait state from an accepted stop before the snapshot carries the intent', () => {
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun(),
      hasActiveRun: true,
      acceptedWait: true,
    })).toEqual({ isWaitingForCombat: true, isStopping: false })
  })

  it('treats an in-flight or acknowledged stop as stop confirmation', () => {
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun(),
      hasActiveRun: true,
      requestedMode: 'now',
    })).toEqual({ isWaitingForCombat: false, isStopping: true })
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun(),
      hasActiveRun: true,
      stopAcknowledged: true,
    })).toEqual({ isWaitingForCombat: false, isStopping: true })
    expect(projectRoguelikeStopState({
      ...IDLE_INPUT,
      run: buildRun({ state: 'stopping' }),
      hasActiveRun: true,
      acceptedWait: true,
    })).toEqual({ isWaitingForCombat: false, isStopping: true })
  })
})

describe('roguelike terminal notice', () => {
  it('names the task on success and explains failures or interruptions', () => {
    expect(describeRoguelikeTerminalRun(buildRun({ state: 'succeeded' }), '集成战略'))
      .toEqual({ message: '集成战略 执行成功', type: 'success' })
    expect(describeRoguelikeTerminalRun(buildRun({ state: 'succeeded' }), undefined))
      .toEqual({ message: '肉鸽任务执行成功', type: 'success' })
    expect(describeRoguelikeTerminalRun(buildRun({ state: 'stopped' }), '集成战略'))
      .toEqual({ message: '肉鸽任务已终止', type: 'warning' })
    expect(describeRoguelikeTerminalRun(
      buildRun({ state: 'failed', error: { message: '设备连接中断' } }),
      '集成战略',
    )).toEqual({ message: '执行失败: 设备连接中断', type: 'error' })
    expect(describeRoguelikeTerminalRun(buildRun({ state: 'interrupted' }), '集成战略'))
      .toEqual({ message: '任务已中断: 服务重启后无法确认执行结果', type: 'warning' })
  })
})
