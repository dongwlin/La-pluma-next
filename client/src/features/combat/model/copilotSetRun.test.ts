// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import {
  describeCombatTaskTerminal,
  describeCopilotSetRunTerminal,
  readCopilotSetRunProjection,
} from './copilotSetRun'

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_copilot_set',
    state: 'running',
    links: { self: '/api/agent/runs/run-1', stop: '/api/agent/actions/stop?runId=run-1' },
    ...overrides,
  }
}

type ItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'stopped'

function entry(itemIndex: number, status: ItemStatus, overrides: Record<string, unknown> = {}) {
  return {
    key: `${itemIndex}:${100 + itemIndex}:normal`,
    itemIndex,
    copilotId: 100 + itemIndex,
    displayStage: `TEST-${itemIndex + 1}`,
    mode: 'normal',
    status,
    ...overrides,
  }
}

describe('readCopilotSetRunProjection', () => {
  it('ignores runs that are not copilot sets', () => {
    expect(readCopilotSetRunProjection(null)).toBeNull()
    expect(readCopilotSetRunProjection(run({ operationId: 'run_task' }))).toBeNull()
  })

  it('reads active progress and folds raid/normal entries onto one item', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'running',
      progress: {
        setId: '48990',
        name: '作业集 48990',
        mode: 'continuous',
        phase: 'running',
        currentEntry: entry(1, 'running'),
        totalSteps: 3,
        successCount: 1,
        failedCount: 1,
        pendingCount: 1,
        taskResults: [
          entry(0, 'success', { mode: 'normal' }),
          entry(0, 'failed', { mode: 'raid', error: '突袭失败' }),
          entry(1, 'running'),
          entry(2, 'pending'),
        ],
      },
    }))

    expect(projection).not.toBeNull()
    expect(projection?.isActive).toBe(true)
    expect(projection?.setId).toBe('48990')
    expect(projection?.itemStatuses.get(0)).toBe('failed')
    expect(projection?.itemStatuses.get(1)).toBe('running')
    expect(projection?.itemStatuses.get(2)).toBe('pending')
    expect(projection?.itemCount).toBe(3)
    expect(projection?.currentItemIndex).toBe(1)
    expect(projection?.failures).toEqual([
      { itemIndex: 0, stage: 'TEST-1', error: '突袭失败' },
    ])
  })

  it('reports waiting runs with their next entry', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'waiting',
      progress: {
        setId: '48990',
        mode: 'manual',
        phase: 'waiting_for_next',
        nextEntry: entry(1, 'pending'),
        currentEntry: null,
        taskResults: [entry(0, 'success'), entry(1, 'pending')],
      },
    }))

    expect(projection?.isWaiting).toBe(true)
    expect(projection?.waitingForNext).toBe(true)
    expect(projection?.nextEntry?.itemIndex).toBe(1)
    expect(projection?.nextEntry?.copilotId).toBe(101)
  })

  it('reads the terminal summary when progress is no longer projected', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'succeeded',
      result: {
        summary: {
          setId: '48990',
          mode: 'manual',
          totalEntries: 3,
          attemptedCount: 2,
          successCount: 1,
          failedCount: 1,
          stoppedCount: 0,
          pendingCount: 2,
          errors: [{ itemIndex: 1, stage: 'TEST-2', error: '作战失败' }],
          taskResults: [
            entry(0, 'success'),
            entry(1, 'failed', { error: '作战失败' }),
            entry(2, 'pending'),
          ],
        },
      },
    }))

    expect(projection?.isActive).toBe(false)
    expect(projection?.totalCount).toBe(3)
    expect(projection?.attemptedCount).toBe(2)
    expect(projection?.successCount).toBe(1)
    expect(projection?.failedCount).toBe(1)
    expect(projection?.pendingCount).toBe(2)
    expect(projection?.failures).toEqual([
      { itemIndex: 1, stage: 'TEST-2', error: '作战失败' },
    ])
  })

  it('does not invent completion when no progress or result is available', () => {
    const projection = readCopilotSetRunProjection(run({ state: 'accepted' }))
    expect(projection?.entries).toEqual([])
    expect(projection?.totalCount).toBe(0)
    expect(projection?.successCount).toBe(0)
    expect(projection?.failures).toEqual([])
  })
})

describe('terminal notices', () => {
  const base = readCopilotSetRunProjection(run({ state: 'succeeded', result: { summary: {} } }))!

  it('summarizes a failed set run with the server error only', () => {
    const failedRun = run({
      state: 'failed',
      error: { message: '作业集执行失败，1 项未完成' },
    })
    expect(describeCopilotSetRunTerminal(failedRun, { ...base, failedCount: 1, successCount: 1 })).toEqual({
      message: '作业集执行失败: 作业集执行失败，1 项未完成',
      type: 'error',
    })
  })

  it('reports partial and full successes differently', () => {
    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 3,
      attemptedCount: 2,
      successCount: 1,
      failedCount: 1,
    })).toEqual({ message: '作业集执行完成：1/3 成功，1 项失败', type: 'warning' })

    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 2,
      attemptedCount: 2,
      successCount: 2,
      failedCount: 0,
    })).toEqual({ message: '作业集执行完成 (2/2 成功)', type: 'success' })
  })

  it('reports stopped sets with their per-item progress', () => {
    expect(describeCopilotSetRunTerminal(run({ state: 'stopped' }), {
      ...base,
      totalCount: 2,
      attemptedCount: 1,
      successCount: 1,
      failedCount: 0,
    })).toEqual({ message: '作业集已终止：1/2 成功', type: 'warning' })
  })

  it('describes single run_task terminals', () => {
    expect(describeCombatTaskTerminal(run({ operationId: 'run_task', state: 'succeeded' }), '保全派驻'))
      .toEqual({ message: '保全派驻 执行成功', type: 'success' })
    expect(describeCombatTaskTerminal(run({ operationId: 'run_task', state: 'stopped' }), undefined))
      .toEqual({ message: '自动战斗已终止', type: 'warning' })
    expect(describeCombatTaskTerminal(run({ operationId: 'run_task', state: 'failed', error: { message: '设备断开' } }), undefined))
      .toEqual({ message: '执行失败: 设备断开', type: 'error' })
    expect(describeCombatTaskTerminal(run({ operationId: 'run_task', state: 'interrupted' }), undefined))
      .toEqual({ message: '任务已中断: 服务重启后无法确认执行结果', type: 'warning' })
  })
})
