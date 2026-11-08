// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun, RunProgress } from '@/features/task-execution'
import type { CopilotQueueEntry } from './copilotQueue'
import {
  describeCopilotQueueRunTerminal,
  readCopilotQueueRunProjection,
  toCopilotQueueRunEntries,
  toCopilotQueueRunEntry,
} from './copilotQueueRun'

const taskResult = (
  clientId: string,
  itemIndex: number,
  status: string,
  overrides: Record<string, unknown> = {},
) => ({
  clientId,
  itemIndex,
  stage: `QUEUE-${itemIndex + 1}`,
  stageId: `queue_${itemIndex + 1}`,
  mode: 'normal',
  status,
  ...overrides,
})

const queueProgress = (taskResults: unknown[], overrides: Record<string, unknown> = {}): RunProgress => ({
  queueId: 'copilot-queue',
  name: '我的作业队列',
  mode: 'continuous',
  failurePolicy: 'continue',
  phase: 'running',
  currentStep: 2,
  totalSteps: 3,
  currentClientId: 'b',
  currentTask: 'QUEUE-2',
  nextEntry: null,
  shouldStop: false,
  message: '作业队列执行中',
  successCount: 1,
  failedCount: 0,
  skippedCount: 0,
  stoppedCount: 0,
  pendingCount: 1,
  taskResults,
  ...overrides,
}) as unknown as RunProgress

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  runId: 'run-queue',
  operationId: 'run_copilot_queue',
  state: 'running',
  links: { self: '/api/agent/runs/run-queue' },
  ...overrides,
})

const queueEntry = (overrides: Partial<CopilotQueueEntry> = {}): CopilotQueueEntry => ({
  id: 'queue-a',
  source: 'link',
  uri: 'prts://101',
  title: '作业一',
  addedAt: 1,
  ...overrides,
})

describe('readCopilotQueueRunProjection', () => {
  it('maps active progress task results by clientId', () => {
    const projection = readCopilotQueueRunProjection(run({
      progress: queueProgress([
        taskResult('a', 0, 'success'),
        taskResult('b', 1, 'running'),
        taskResult('c', 2, 'pending'),
      ]),
    }))

    expect(projection).not.toBeNull()
    expect(projection).toMatchObject({
      runId: 'run-queue',
      state: 'running',
      isActive: true,
      isTerminal: false,
      queueId: 'copilot-queue',
      name: '我的作业队列',
      mode: 'continuous',
      failurePolicy: 'continue',
      currentClientId: 'b',
      currentItemIndex: 1,
      totalCount: 3,
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    })
    expect(projection?.statuses.get('a')).toEqual({ status: 'success' })
    expect(projection?.statuses.get('b')).toEqual({ status: 'running' })
    expect(projection?.statuses.get('c')).toEqual({ status: 'pending' })
    expect(projection?.failures).toEqual([])
  })

  it('reads the terminal summary and keeps failure reasons per clientId', () => {
    const projection = readCopilotQueueRunProjection(run({
      state: 'succeeded',
      progress: queueProgress([taskResult('stale', 0, 'running')]),
      result: {
        summary: {
          queueId: 'copilot-queue',
          name: '我的作业队列',
          mode: 'continuous',
          failurePolicy: 'stop',
          totalEntries: 3,
          successCount: 1,
          failedCount: 1,
          skippedCount: 1,
          stoppedCount: 0,
          pendingCount: 0,
          durationMs: 5_000,
          errors: [{ clientId: 'b', stage: 'QUEUE-2', error: '作战失败' }],
          taskResults: [
            taskResult('a', 0, 'success'),
            taskResult('b', 1, 'failed', { error: '作战失败' }),
            taskResult('c', 2, 'skipped'),
          ],
        },
      },
    }))

    expect(projection).toMatchObject({
      state: 'succeeded',
      isActive: false,
      isTerminal: true,
      failurePolicy: 'stop',
      failedCount: 1,
      skippedCount: 1,
      pendingCount: 0,
    })
    expect(projection?.statuses.get('b')).toEqual({ status: 'failed', error: '作战失败' })
    expect(projection?.failures).toEqual([
      { clientId: 'b', stage: 'QUEUE-2', error: '作战失败' },
    ])
    expect(projection?.summaryErrors).toEqual([
      { clientId: 'b', stage: 'QUEUE-2', error: '作战失败' },
    ])
    expect(projection?.statuses.has('stale')).toBe(false)
  })

  it('counts known task results when the server omits counters and never guesses success', () => {
    const projection = readCopilotQueueRunProjection(run({
      progress: {
        queueId: 'copilot-queue',
        taskResults: [
          taskResult('a', 0, 'failed', { error: '作战失败' }),
          { clientId: 'b', itemIndex: 1 },
          { itemIndex: 2, status: 'success' },
        ],
      } as unknown as RunProgress,
      result: { summary: { totalEntries: 2 } },
    }))

    expect(projection?.taskResults).toHaveLength(2)
    expect(projection?.statuses.get('a')).toEqual({ status: 'failed', error: '作战失败' })
    expect(projection?.statuses.get('b')).toEqual({ status: 'pending' })
    expect(projection?.totalCount).toBe(2)
    expect(projection?.failedCount).toBe(1)
    expect(projection?.pendingCount).toBe(1)
    expect(projection?.successCount).toBe(0)
  })

  it('fills the failed entry reason from summary errors when the item omits it', () => {
    const projection = readCopilotQueueRunProjection(run({
      state: 'failed',
      result: {
        summary: {
          totalEntries: 1,
          failedCount: 1,
          errors: [{ clientId: 'a', stage: 'QUEUE-1', error: '缺少干员' }],
          taskResults: [taskResult('a', 0, 'failed')],
        },
      },
    }))

    expect(projection?.statuses.get('a')).toEqual({ status: 'failed', error: '缺少干员' })
    expect(projection?.failures).toEqual([
      { clientId: 'a', stage: 'QUEUE-1', error: '缺少干员' },
    ])
  })

  it('keeps an empty projection when progress and summary are missing', () => {
    const projection = readCopilotQueueRunProjection(run({ state: 'interrupted' }))

    expect(projection).toMatchObject({
      state: 'interrupted',
      isActive: false,
      isTerminal: true,
      taskResults: [],
      totalCount: 0,
      successCount: 0,
      failedCount: 0,
    })
    expect(projection?.statuses.size).toBe(0)
    expect(projection?.nextEntry).toBeNull()
  })

  it('reads the waiting next entry for a manual queue', () => {
    const projection = readCopilotQueueRunProjection(run({
      state: 'waiting',
      progress: queueProgress(
        [taskResult('a', 0, 'success'), taskResult('b', 1, 'pending')],
        {
          mode: 'manual',
          phase: 'waiting_for_next',
          currentClientId: null,
          nextEntry: { clientId: 'b', itemIndex: 1, stage: 'QUEUE-2', mode: 'raid' },
        },
      ),
    }))

    expect(projection).toMatchObject({
      isWaiting: true,
      waitingForNext: true,
      currentClientId: null,
      nextEntry: {
        clientId: 'b',
        itemIndex: 1,
        stage: 'QUEUE-2',
        mode: 'raid',
      },
    })
  })

  it('only accepts the queue run operation', () => {
    expect(readCopilotQueueRunProjection(run({ operationId: 'run_copilot_set' }))).toBeNull()
    expect(readCopilotQueueRunProjection(null)).toBeNull()
  })
})

describe('toCopilotQueueRunEntries', () => {
  it('maps queue entries to contract entries in queue order', () => {
    expect(toCopilotQueueRunEntries([
      queueEntry({ id: 'a', source: 'link', uri: 'prts://101' }),
      queueEntry({ id: 'b', source: 'file', uri: '/data/copilot-imports/uuid.json' }),
      queueEntry({ id: 'c', source: 'file', uri: '"/data/copilot-imports/a b.json"' }),
    ], 'raid')).toEqual([
      { clientId: 'a', source: 'prts', copilotId: 101, mode: 'raid' },
      { clientId: 'b', source: 'file', filename: '/data/copilot-imports/uuid.json', mode: 'raid' },
      { clientId: 'c', source: 'file', filename: '/data/copilot-imports/a b.json', mode: 'raid' },
    ])
  })

  it('keeps preset-formation entries on normal mode and drops set URIs', () => {
    expect(toCopilotQueueRunEntry(queueEntry({ uri: 'prts://7', presetFormation: true }), 'raid'))
      .toEqual({ clientId: expect.any(String), source: 'prts', copilotId: 7, mode: 'normal' })
    expect(toCopilotQueueRunEntry(queueEntry({ uri: 'prts://s48990' }))).toBeNull()
    expect(toCopilotQueueRunEntry(queueEntry({ uri: '/data/local.json' }))).toBeNull()
    expect(toCopilotQueueRunEntries([
      queueEntry({ id: 'bad', uri: '/data/local.json' }),
      queueEntry({ id: 'good', uri: 'prts://7' }),
    ])).toEqual([{ clientId: 'good', source: 'prts', copilotId: 7, mode: 'normal' }])
  })
})

describe('describeCopilotQueueRunTerminal', () => {
  it('reports failed entries as a warning for a succeeded queue', () => {
    const terminalRun = run({ state: 'succeeded' })
    const projection = readCopilotQueueRunProjection(run({
      state: 'succeeded',
      result: {
        summary: {
          totalEntries: 2,
          successCount: 1,
          failedCount: 1,
          taskResults: [
            taskResult('a', 0, 'success'),
            taskResult('b', 1, 'failed', { error: '作战失败' }),
          ],
        },
      },
    }))

    expect(projection).not.toBeNull()
    expect(describeCopilotQueueRunTerminal(terminalRun, projection!)).toEqual({
      message: '作业队列执行完成：1/2 成功，1 项失败',
      type: 'warning',
    })
  })

  it('reports a failed queue run with the server message', () => {
    const terminalRun = run({
      state: 'failed',
      error: { message: '队列执行器异常' },
    })
    const projection = readCopilotQueueRunProjection(terminalRun)

    expect(projection).not.toBeNull()
    expect(describeCopilotQueueRunTerminal(terminalRun, projection!)).toEqual({
      message: '作业队列执行失败: 队列执行器异常',
      type: 'error',
    })
  })
})
