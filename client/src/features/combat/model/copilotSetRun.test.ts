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

type ItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'stopped'

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

  it('keeps skipped entries and never lets them outrank executed results', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'running',
      progress: {
        setId: '48990',
        mode: 'continuous',
        phase: 'running',
        successCount: 1,
        pendingCount: 1,
        taskResults: [
          entry(0, 'success', { mode: 'raid' }),
          entry(0, 'skipped', { mode: 'normal' }),
          entry(1, 'skipped'),
          entry(2, 'pending'),
        ],
      },
    }))

    expect(projection?.itemStatuses.get(0)).toBe('pending')
    expect(projection?.itemStatuses.get(1)).toBe('skipped')
    expect(projection?.skippedCount).toBe(2)
    expect(projection?.attemptedCount).toBe(1)
  })

  it('folds an item to success only after every mode succeeded', () => {
    const partial = readCopilotSetRunProjection(run({
      state: 'waiting',
      progress: {
        setId: '48990',
        mode: 'manual',
        phase: 'waiting_for_next',
        taskResults: [
          entry(0, 'success', { mode: 'normal' }),
          entry(0, 'pending', { mode: 'raid' }),
        ],
      },
    }))
    expect(partial?.itemStatuses.get(0)).toBe('pending')

    const completed = readCopilotSetRunProjection(run({
      state: 'running',
      progress: {
        setId: '48990',
        mode: 'continuous',
        phase: 'running',
        taskResults: [
          entry(0, 'success', { mode: 'normal' }),
          entry(0, 'success', { mode: 'raid' }),
          entry(1, 'running'),
        ],
      },
    }))
    expect(completed?.itemStatuses.get(0)).toBe('success')
    expect(completed?.itemStatuses.get(1)).toBe('running')
  })

  it('counts skipped entries from the terminal summary when provided', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'succeeded',
      result: {
        summary: {
          setId: '48990',
          mode: 'continuous',
          totalEntries: 3,
          attemptedCount: 1,
          successCount: 1,
          failedCount: 0,
          skippedCount: 3,
          pendingCount: 1,
          taskResults: [
            entry(0, 'success'),
            entry(1, 'skipped'),
            entry(2, 'pending'),
          ],
        },
      },
    }))

    expect(projection?.skippedCount).toBe(3)
    expect(projection?.attemptedCount).toBe(1)
    expect(projection?.pendingCount).toBe(1)
  })

  it('degrades skipped counts to zero when the server has no such field', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'running',
      progress: {
        setId: '48990',
        mode: 'continuous',
        phase: 'running',
        taskResults: [entry(0, 'success'), entry(1, 'pending')],
      },
    }))

    expect(projection?.skippedCount).toBe(0)
  })

  it('distinguishes summary entries from the attempt queue', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'succeeded',
      result: {
        summary: {
          setId: '48990',
          mode: 'manual',
          plannedEntries: 5,
          queuedEntries: 1,
          totalEntries: 5,
          attemptedCount: 1,
          successCount: 1,
          failedCount: 0,
          skippedCount: 4,
          pendingCount: 0,
          taskResults: [
            entry(0, 'success'),
            entry(1, 'skipped'),
            entry(2, 'skipped'),
            entry(3, 'skipped'),
            entry(4, 'skipped'),
          ],
        },
      },
    }))

    expect(projection?.totalCount).toBe(5)
    expect(projection?.queuedCount).toBe(1)
    expect(projection?.totalCount).toBe(projection?.entries.length)
  })

  it('reads the attempt queue from active progress steps', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'running',
      progress: {
        setId: '48990',
        mode: 'continuous',
        phase: 'running',
        totalSteps: 1,
        taskResults: [entry(0, 'running'), entry(1, 'skipped'), entry(2, 'skipped')],
      },
    }))

    expect(projection?.totalCount).toBe(3)
    expect(projection?.queuedCount).toBe(1)
  })

  it('leaves the queue total unknown when the server omits it', () => {
    const projection = readCopilotSetRunProjection(run({
      state: 'accepted',
      result: { summary: { setId: '48990', totalEntries: 2, taskResults: [entry(0, 'success')] } },
    }))

    expect(projection?.queuedCount).toBeNull()
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
      queuedCount: 3,
      attemptedCount: 2,
      successCount: 1,
      failedCount: 1,
    })).toEqual({ message: '作业集执行完成：1/3 成功，1 项失败', type: 'warning' })

    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 2,
      queuedCount: 2,
      attemptedCount: 2,
      successCount: 2,
      failedCount: 0,
    })).toEqual({ message: '作业集执行完成 (2/2 成功)', type: 'success' })
  })

  it('reports stopped sets with their per-item progress', () => {
    expect(describeCopilotSetRunTerminal(run({ state: 'stopped' }), {
      ...base,
      totalCount: 2,
      queuedCount: 2,
      attemptedCount: 1,
      successCount: 1,
      failedCount: 0,
    })).toEqual({ message: '作业集已终止：1/2 成功', type: 'warning' })
  })

  it('mentions skipped items in terminal summaries only when present', () => {
    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 2,
      queuedCount: 1,
      attemptedCount: 1,
      successCount: 1,
      failedCount: 0,
      skippedCount: 1,
    })).toEqual({ message: '作业集执行完成 (1/1 成功)，跳过 1 项', type: 'success' })

    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 1,
      queuedCount: 1,
      attemptedCount: 1,
      successCount: 1,
      failedCount: 0,
    })).toEqual({ message: '作业集执行完成 (1/1 成功)', type: 'success' })
  })

  it('falls back to attempted entries when the queue total is unknown', () => {
    expect(describeCopilotSetRunTerminal(run({ state: 'succeeded' }), {
      ...base,
      totalCount: 4,
      queuedCount: null,
      attemptedCount: 2,
      successCount: 2,
      failedCount: 0,
    })).toEqual({ message: '作业集执行完成 (2/2 成功)', type: 'success' })
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
