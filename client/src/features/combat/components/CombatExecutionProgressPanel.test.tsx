// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatExecutionElapsed } from '../model/executionProgress'
import type { ExecutionProgressView } from '../model/executionProgress'
import CombatExecutionProgressPanel from './CombatExecutionProgressPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function progress(overrides: Partial<ExecutionProgressView> = {}): ExecutionProgressView {
  return {
    runId: 'run-1',
    operationId: 'run_copilot_set',
    state: 'running',
    isActive: true,
    name: null,
    stage: 'TEST-2',
    step: { current: 2, total: 3 },
    startedAtMs: Date.now() - 5_000,
    durationMs: null,
    ...overrides,
  }
}

describe('CombatExecutionProgressPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const render = async (node: ReactNode) => {
    await act(async () => root.render(node))
  }

  it('renders nothing without a tracked run', async () => {
    await render(<CombatExecutionProgressPanel progress={null} />)

    expect(container.querySelector('[aria-label="本次执行进度"]')).toBeNull()
  })

  it('renders nothing when the run has no progress facts to add', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({ state: 'accepted', name: null, stage: null, step: null, startedAtMs: null })}
      />,
    )

    expect(container.querySelector('[aria-label="本次执行进度"]')).toBeNull()
  })

  it('shows the entry position, stage and elapsed time for a set run', async () => {
    await render(<CombatExecutionProgressPanel progress={progress()} />)

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('本次执行进度')
    expect(panel?.textContent).toContain('正在执行 本次第 2 / 3 项')
    expect(panel?.textContent).toContain('关卡: TEST-2')
    expect(panel?.textContent).toContain('已用时')
    expect(panel?.textContent).not.toContain('执行中')
    expect(panel?.textContent).not.toContain('已完成')
    expect(panel?.querySelectorAll('button')).toHaveLength(0)
  })

  it('counts entries rather than stages when raid and normal share one stage', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({ step: { current: 3, total: 4 } })}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('本次第 3 / 4 项')
    expect(panel?.textContent).not.toContain('3 / 4 关')
  })

  it('keeps the waiting entry position without claiming it is executing', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({ state: 'waiting', stage: null, step: { current: 2, total: 3 } })}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('本次第 2 / 3 项')
    expect(panel?.textContent).not.toContain('正在执行')
  })

  it('degrades a single task run to its task name and elapsed time', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({
          operationId: 'run_task',
          name: '自动战斗作业',
          stage: null,
          step: null,
        })}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('自动战斗作业')
    expect(panel?.textContent).toContain('已用时')
    expect(panel?.textContent).not.toContain('本次第')
    expect(panel?.textContent).not.toContain('关卡:')
  })

  it('keeps a terminal run visible with its server duration', async () => {
    const durationMs = 65_000
    await render(
      <CombatExecutionProgressPanel
        progress={progress({
          state: 'succeeded',
          isActive: false,
          stage: null,
          step: null,
          startedAtMs: null,
          durationMs,
        })}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain(`已用时 ${formatExecutionElapsed(durationMs)}`)
    expect(panel?.querySelectorAll('button')).toHaveLength(0)
  })

  it('advances the elapsed time while the run is active', async () => {
    vi.useFakeTimers()
    try {
      const startedAtMs = Date.now()
      await render(
        <CombatExecutionProgressPanel progress={progress({ startedAtMs })} />,
      )

      const panel = () => container.querySelector('[aria-label="本次执行进度"]')
      expect(panel()?.textContent).toContain('已用时 0 秒')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(panel()?.textContent).toContain('已用时 2 秒')
    } finally {
      vi.useRealTimers()
    }
  })
})
