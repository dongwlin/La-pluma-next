// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusMessageType } from '@/features/runtime-status'
import type { AgentRun, ExecutionController, ExecutionControllerState } from '@/features/task-execution'
import type { CopilotSetItemStatus } from '../model/copilotSetRun'
import { COMBAT_EXECUTION_SCOPE, useCombatExecution, type CombatExecution } from './useCombatExecution'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const controllerState: { current: ExecutionControllerState | null } = { current: null }

vi.mock('@/features/task-execution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  return {
    ...actual,
    useExecutionSnapshot: () => controllerState.current,
  }
})

type EntryStatus = CopilotSetItemStatus

interface TestEntry {
  key: string
  itemIndex: number
  copilotId: number
  stage: string
  displayStage: string
  mode: string
  status: EntryStatus
  error?: string
}

function entry(itemIndex: number, status: EntryStatus, overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    key: `${itemIndex}:${100 + itemIndex}:normal`,
    itemIndex,
    copilotId: 100 + itemIndex,
    stage: `TEST-${itemIndex + 1}`,
    displayStage: `TEST-${itemIndex + 1}`,
    mode: 'normal',
    status,
    ...overrides,
  }
}

/**
 * 服务端作业集进度投影：attempted 条目在前，计划推导的 skipped 条目
 * （未选中且此前未通关）追加在 taskResults 尾部，从 run 开始就存在。
 */
function manualRun(
  state: AgentRun['state'],
  taskResults: TestEntry[],
  nextIndex: number | null = null,
): AgentRun {
  return {
    runId: 'run-manual',
    operationId: 'run_copilot_set',
    state,
    progress: {
      setId: '48990',
      name: '作业集 48990',
      mode: 'manual',
      phase: state === 'waiting' ? 'waiting_for_next' : 'running',
      nextEntry: nextIndex === null ? null : entry(nextIndex, 'pending'),
      currentEntry: null,
      taskResults,
    },
    links: { self: '/api/agent/runs/run-manual', stop: '/api/agent/actions/stop?runId=run-manual' },
  } as unknown as AgentRun
}

function combatState(trackedRun: AgentRun | null): ExecutionControllerState {
  return {
    phase: 'live',
    identity: 'tracked',
    submission: 'idle',
    snapshot: null,
    trackedRunId: trackedRun?.runId ?? null,
    trackedScope: COMBAT_EXECUTION_SCOPE,
    trackedRun,
    lastError: null,
    lastSyncedAt: null,
    hasActiveRun: true,
    occupancy: null,
  }
}

let root: Root
let container: HTMLDivElement
let rerender: (() => void) | null = null
let latest: CombatExecution | null = null
const messages: Array<{ message: string; type?: StatusMessageType }> = []

function Harness({ controller, stopOnFailure }: { controller: ExecutionController; stopOnFailure: boolean }) {
  const [, setTick] = useState(0)
  const execution = useCombatExecution({
    notify: (message, type) => messages.push({ message, type }),
    stopOnFailure,
    controller,
  })
  useEffect(() => {
    rerender = () => setTick(tick => tick + 1)
    latest = execution
  })
  return null
}

describe('useCombatExecution run projection', () => {
  beforeEach(() => {
    messages.length = 0
    rerender = null
    latest = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const flush = async () => {
    await act(async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
    })
  }

  const renderHarness = async (controller: ExecutionController, stopOnFailure = false) => {
    await act(async () => {
      root.render(<Harness controller={controller} stopOnFailure={stopOnFailure} />)
    })
    await flush()
  }

  it('keeps the set-run projection stable across unrelated re-renders', async () => {
    controllerState.current = combatState(manualRun('waiting', [entry(0, 'success')], 1))
    await renderHarness({ getState: () => controllerState.current } as unknown as ExecutionController)

    const before = latest?.setRun
    expect(before).not.toBeNull()

    await act(async () => rerender?.())

    expect(latest?.setRun).toBe(before)
  })

  it('stops a failed manual set even when plan-derived skipped entries shadow the failure', async () => {
    // 失败条目之后跟着计划推导的 skipped 条目（更大 itemIndex，从 run 开始就存在）：
    // 它们不能被当作「最近结算」，否则失败后停止策略永不触发。
    const run = manualRun('waiting', [
      entry(1, 'failed', { error: '作战失败' }),
      entry(3, 'skipped'),
      entry(4, 'skipped'),
    ])
    controllerState.current = combatState(run)
    const stopTrackedRun = vi.fn(async () => ({ success: true, data: { alreadyTerminal: false } }))
    const controller = {
      getState: () => controllerState.current,
      subscribe: () => () => {},
      stopTrackedRun,
    } as unknown as ExecutionController

    await renderHarness(controller, true)

    expect(stopTrackedRun).toHaveBeenCalledOnce()
    expect(messages).toContainEqual({
      message: '作业 2/3 执行失败: 作战失败，已按队列策略停止',
      type: 'error',
    })
    expect(messages.some(({ message }) => message.includes('已跳过'))).toBe(false)
  })

  it('reports the actually settled entry while waiting instead of plan-derived skipped entries', async () => {
    controllerState.current = combatState(manualRun(
      'waiting',
      [entry(0, 'success'), entry(1, 'pending'), entry(2, 'skipped'), entry(3, 'skipped')],
      1,
    ))
    await renderHarness({ getState: () => controllerState.current } as unknown as ExecutionController)

    expect(messages).toContainEqual({ message: '作业 1/4 完成，等待开始下一关' })

    // 继续执行后新的结算要能覆盖提示去重键，不能被尾部 skipped 条目遮蔽。
    controllerState.current = combatState(manualRun(
      'waiting',
      [entry(0, 'success'), entry(1, 'failed', { error: '作战失败' }), entry(2, 'pending'), entry(3, 'skipped')],
      2,
    ))
    await act(async () => rerender?.())
    await flush()

    expect(messages).toContainEqual({ message: '作业 2/4 执行失败: 作战失败，等待开始下一关' })
    expect(messages.some(({ message }) => message.includes('已跳过'))).toBe(false)
  })
})
