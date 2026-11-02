// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogsWorkspace from './LogsWorkspace'
import type { LogEntry } from '../types'
import type { AgentRun } from '@/features/task-execution'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (message: string, runId?: string): LogEntry => ({
  time: '10:00:00',
  level: 'INFO',
  message,
  ...(runId ? { runId } : {}),
})

const fixtureLogs: readonly LogEntry[] = [
  row('本次执行的输出', 'run-1'),
  row('上一次执行的输出', 'run-0'),
  row('没有归属的输出'),
]

// 会话与执行快照都是外部所有者：测试注入固定状态，只验证工作区的过滤接线。
vi.mock('../hooks/useLogsSession', () => ({
  useLogsSession: () => ({
    realtime: {
      logs: fixtureLogs,
      error: null,
      paused: false,
      start: () => {},
      stop: () => {},
      refresh: () => {},
      pause: () => {},
      resume: () => {},
      clear: () => {},
    },
    history: {
      viewing: false,
      files: [],
      filesPhase: 'ready',
      filesError: null,
      selectedFile: null,
      logs: [],
      readPhase: 'idle',
      error: null,
      selectFile: () => {},
      backToRealtime: () => {},
      reloadFiles: async () => 'ready' as const,
      retry: () => {},
      reconcileSelection: () => false,
    },
    commandPending: null,
    enterHistory: () => {},
    backToRealtime: () => {},
    clearRealtimeLogs: async () => ({ status: 'succeeded', message: 'ok' }),
    cleanupHistoryLogs: async () => ({ status: 'succeeded', message: 'ok' }),
  }),
}))

let trackedRun: AgentRun | null = null

vi.mock('@/features/task-execution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  return {
    ...actual,
    useExecutionSnapshot: () => ({
      trackedRun,
    } as unknown as ReturnType<typeof actual.useExecutionSnapshot>),
  }
})

let container: HTMLDivElement
let root: Root

const renderWorkspace = async () => {
  await act(async () => root.render(<LogsWorkspace />))
  await act(async () => {
    await Promise.resolve()
  })
}

const visibleRows = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="log"] .log-row .log-message > span'))
    .map(node => node.textContent)

const findCurrentRunSwitch = () =>
  Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .find(input => input.getAttribute('aria-label') === '只看本次执行')

const activeRun = (runId: string): AgentRun => ({
  runId,
  operationId: `op-${runId}`,
  state: 'running',
  links: { self: `/api/runs/${runId}` },
})

describe('LogsWorkspace run filtering', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    trackedRun = null
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('filters the realtime buffer by the active tracked run by default', async () => {
    trackedRun = activeRun('run-1')
    await renderWorkspace()

    expect(visibleRows()).toEqual(['本次执行的输出'])
  })

  it('shows every row after the current-run switch is turned off', async () => {
    trackedRun = activeRun('run-1')
    await renderWorkspace()

    const currentRunSwitch = findCurrentRunSwitch()
    expect(currentRunSwitch?.checked).toBe(true)
    await act(async () => currentRunSwitch?.click())
    await act(async () => {
      await Promise.resolve()
    })

    expect(visibleRows()).toEqual(['本次执行的输出', '上一次执行的输出', '没有归属的输出'])
  })

  it('does not filter without an active tracked run even when the switch stays on', async () => {
    await renderWorkspace()
    expect(visibleRows()).toEqual(['本次执行的输出', '上一次执行的输出', '没有归属的输出'])

    // 结束态的 tracked run 不算活动 run，仍然展示全部
    trackedRun = { ...activeRun('run-0'), state: 'succeeded' }
    await renderWorkspace()
    expect(visibleRows()).toEqual(['本次执行的输出', '上一次执行的输出', '没有归属的输出'])
  })
})
