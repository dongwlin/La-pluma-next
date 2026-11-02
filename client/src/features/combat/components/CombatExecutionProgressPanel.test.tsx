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
    stateLabel: '执行中',
    name: '作业集 48990',
    stage: 'TEST-2',
    step: { current: 2, total: 3 },
    counts: { success: 1, failed: 1, skipped: 0, pending: 1 },
    startedAtMs: Date.now() - 5_000,
    durationMs: null,
    ...overrides,
  }
}

describe('CombatExecutionProgressPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const onStop = vi.fn()

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
    await render(<CombatExecutionProgressPanel progress={null} isStopping={false} onStop={onStop} />)

    expect(container.querySelector('[aria-label="本次执行进度"]')).toBeNull()
  })

  it('shows the set run step, stage, counts and a stop entry', async () => {
    await render(<CombatExecutionProgressPanel progress={progress()} isStopping={false} onStop={onStop} />)

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('本次执行进度')
    expect(panel?.textContent).toContain('执行中')
    expect(panel?.textContent).toContain('正在执行 第 2 / 3 关')
    expect(panel?.textContent).toContain('作业集 48990')
    expect(panel?.textContent).toContain('关卡: TEST-2')
    expect(panel?.textContent).toContain('已完成 1 · 失败 1 · 待执行 1')
    expect(panel?.textContent).not.toContain('跳过')
    expect(panel?.textContent).toContain('已用时')

    const stop = Array.from(panel?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.trim() === '终止')
    expect(stop).toBeDefined()
    await act(async () => stop?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('adds the skipped count only when skipped items exist', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({ counts: { success: 1, failed: 0, skipped: 2, pending: 1 } })}
        isStopping={false}
        onStop={onStop}
      />,
    )

    expect(container.querySelector('[aria-label="本次执行进度"]')?.textContent)
      .toContain('已完成 1 · 失败 0 · 跳过 2 · 待执行 1')
  })

  it('degrades a single task run to name and state only', async () => {
    await render(
      <CombatExecutionProgressPanel
        progress={progress({
          operationId: 'run_task',
          name: '自动战斗作业',
          stage: null,
          step: null,
          counts: null,
        })}
        isStopping={false}
        onStop={onStop}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('自动战斗作业')
    expect(panel?.textContent).toContain('执行中')
    expect(panel?.textContent).not.toContain('关')
    expect(panel?.textContent).not.toContain('已完成')
    expect(panel?.textContent).not.toContain('关卡:')
  })

  it('keeps a terminal run visible without a stop entry and uses its duration', async () => {
    const durationMs = 65_000
    await render(
      <CombatExecutionProgressPanel
        progress={progress({
          state: 'succeeded',
          isActive: false,
          stateLabel: '已完成',
          stage: null,
          step: null,
          counts: { success: 3, failed: 0, skipped: 0, pending: 0 },
          startedAtMs: null,
          durationMs,
        })}
        isStopping={false}
        onStop={onStop}
      />,
    )

    const panel = container.querySelector('[aria-label="本次执行进度"]')
    expect(panel?.textContent).toContain('已完成')
    expect(panel?.textContent).toContain('已完成 3 · 失败 0')
    expect(panel?.textContent).toContain(`已用时 ${formatExecutionElapsed(durationMs)}`)
    expect(Array.from(panel?.querySelectorAll('button') ?? [])).toEqual([])
  })

  it('stops counting elapsed time while the stop request is in flight', async () => {
    vi.useFakeTimers()
    try {
      const startedAtMs = Date.now()
      await render(
        <CombatExecutionProgressPanel
          progress={progress({ state: 'stopping', stateLabel: '正在终止', startedAtMs })}
          isStopping
          onStop={onStop}
        />,
      )

      const panel = () => container.querySelector('[aria-label="本次执行进度"]')
      expect(panel()?.textContent).toContain('正在终止')
      const stopButton = Array.from(panel()?.querySelectorAll('button') ?? [])
        .find(button => button.textContent?.includes('正在终止'))
      expect(stopButton?.disabled).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(panel()?.textContent).toContain('已用时 2 秒')
    } finally {
      vi.useRealTimers()
    }
  })
})
