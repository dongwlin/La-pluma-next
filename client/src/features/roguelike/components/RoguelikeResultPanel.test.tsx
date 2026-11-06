// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import type { RoguelikeRunSummary } from '../model/runSummary'
import RoguelikeResultPanel from './RoguelikeResultPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/features/runtime-status', () => ({
  RuntimeDiagnosticsPanel: ({ command }: { command?: string }) => (
    <div data-testid="runtime-diagnostics" data-command={command ?? ''} />
  ),
}))

function summary(overrides: Partial<RoguelikeRunSummary> = {}): RoguelikeRunSummary {
  return {
    command: 'roguelike',
    theme: 'Phantom',
    status: 'success',
    observed: true,
    message: '肉鸽结算：第 5 层 · 得分 1200',
    settlement: {
      gamePass: true,
      floor: 5,
      step: 42,
      combat: 12,
      recruit: 8,
      collection: 21,
      boss: 2,
      emergency: 3,
      difficulty: 9,
      score: 1200,
      exp: 320,
      skill: '后勤分队',
    },
    investment: null,
    events: [{ name: '不期而遇', option: '迎战' }],
    coppers: [],
    milestones: ['深入调查已完成'],
    warnings: ['已达本次投资上限'],
    strategy: null,
    combats: 6,
    taskChain: { started: true, completed: true, failed: false, stopped: false },
    ...overrides,
  }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'succeeded',
    durationMs: 65_000,
    result: { summary: summary() },
    links: { self: '/api/agent/runs/run-1' },
    ...overrides,
  }
}

function activeRun(runId: string, message?: string): AgentRun {
  return {
    runId,
    operationId: 'run_task',
    state: 'running',
    progress: message ? { message } : undefined,
    links: { self: `/api/agent/runs/${runId}` },
  }
}

let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })
}

const renderPanel = async (panelRun: AgentRun | null, command?: string) => {
  await act(async () => root.render(<RoguelikeResultPanel run={panelRun} command={command} />))
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('[aria-label="执行结果"]')

describe('RoguelikeResultPanel', () => {
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

  it('shows an empty state before the first run and still embeds diagnostics', async () => {
    await renderPanel(null, 'reclamation')

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行结果')
    expect(text).toContain('还没有执行记录')
    expect(text).not.toContain('本次执行没有可用的结构化结果')
    expect(container.querySelector('[data-testid="runtime-diagnostics"]')?.getAttribute('data-command'))
      .toBe('reclamation')
  })

  it('shows the progress of an active run without claiming success', async () => {
    await renderPanel(activeRun('run-2', '正在执行：第 3 层'), 'roguelike')

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('正在执行：第 3 层')
    expect(text).not.toContain('成功')
    expect(text).not.toContain('上次执行结果')
    expect(container.querySelector('[data-testid="runtime-diagnostics"]')?.getAttribute('data-command'))
      .toBe('roguelike')
  })

  it('renders the terminal summary with message, metrics, events and notes', async () => {
    await renderPanel(run(), 'roguelike')

    const text = panel()?.textContent ?? ''
    expect(text).toContain('最近一次执行')
    expect(text).toContain('成功')
    expect(text).toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(text).toContain('主题')
    expect(text).toContain('Phantom')
    expect(text).toContain('耗时')
    expect(text).toContain('1 分 5 秒')
    expect(text).toContain('得分')
    expect(text).toContain('1200')
    expect(text).toContain('战斗次数')
    expect(text).toContain('事件')
    expect(text).toContain('不期而遇：迎战')
    expect(text).toContain('里程碑：深入调查已完成')
    expect(text).toContain('警告：已达本次投资上限')
  })

  it('reads a failed run summary from the error details', async () => {
    await renderPanel(run({
      state: 'failed',
      result: undefined,
      durationMs: null,
      error: {
        code: 'AGENT_RUN_FAILED',
        message: '设备连接中断',
        details: { summary: summary({ status: 'failed', message: '集成战略执行失败：设备连接中断' }) },
      },
    }))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('失败')
    expect(text).toContain('集成战略执行失败：设备连接中断')
    expect(text).not.toContain('耗时')
  })

  it('never renders the raw error text in place of a missing summary', async () => {
    await renderPanel(run({
      state: 'failed',
      durationMs: null,
      result: { summary: 'MaaCore 进程异常退出' },
      error: { message: 'MaaCore 进程异常退出', details: {} },
    }))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('本次执行没有可用的结构化结果')
    expect(text).not.toContain('MaaCore 进程异常退出')
  })

  it('keeps the last terminal summary visible while a new run is executing', async () => {
    await renderPanel(run())
    await renderPanel(activeRun('run-2', '正在执行：第 1 层'))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('上次执行结果')
    expect(text).toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(text).not.toContain('最近一次执行')
  })

  it('replaces the retained summary once the new run finishes without a usable summary', async () => {
    await renderPanel(run())
    await renderPanel(activeRun('run-2', '正在执行：第 1 层'))
    await renderPanel(run({ runId: 'run-2', state: 'succeeded', result: { summary: 'not-a-summary' } }))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('本次执行没有可用的结构化结果')
    expect(text).not.toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(text).not.toContain('上次执行结果')
  })
})
