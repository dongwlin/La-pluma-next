// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import type { RoguelikeRunSummary } from '../model/runSummary'
import RoguelikeResultPanel from './RoguelikeResultPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const renderPanel = async (
  panelRun: AgentRun | null,
  taskName?: string | null,
) => {
  await act(async () => root.render(
    <RoguelikeResultPanel run={panelRun} taskName={taskName} />,
  ))
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

  it('shows an empty state before the first run without diagnostics or ownership', async () => {
    await renderPanel(null)

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行结果')
    expect(text).toContain('还没有执行记录')
    expect(text).not.toContain('本次执行没有可用的结构化结果')
    expect(text).not.toContain('任务归属')
    expect(text).not.toContain('执行后查看结算')
  })

  it('shows the progress of an active run without claiming success', async () => {
    await renderPanel(activeRun('run-2', '正在执行：第 3 层'))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('正在执行：第 3 层')
    expect(text).not.toContain('成功')
    expect(text).not.toContain('上次执行结果')
    expect(text).not.toContain('本次执行进行中')
  })

  it('renders the terminal summary with message, metrics, events and notes', async () => {
    await renderPanel(run())

    const text = panel()?.textContent ?? ''
    expect(text).not.toContain('最近一次执行')
    expect(text).toContain('成功')
    expect(text).toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(text).toContain('耗时')
    expect(text).toContain('1 分 5 秒')
    expect(text).toContain('事件')
    expect(text).toContain('备注')
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

  it.each([
    ['failed', '失败'],
    ['stopped', '已停止'],
    ['interrupted', '已中断'],
  ] as const)('keeps the %s terminal state visible without a summary', async (state, label) => {
    await renderPanel(run({ runId: `run-${state}`, state, durationMs: null, result: undefined }))

    const text = panel()?.textContent ?? ''
    expect(text).toContain(label)
    expect(text).toContain('本次执行没有可用的结构化结果')
    expect(text).not.toContain('成功')
  })

  it('labels a succeeded run without a summary as success', async () => {
    await renderPanel(run({ result: undefined, durationMs: null }))

    const text = panel()?.textContent ?? ''
    expect(text).toContain('成功')
    expect(text).toContain('本次执行没有可用的结构化结果')
  })

  it('upgrades the retained summary when it arrives after the terminal state', async () => {
    await renderPanel(run({ runId: 'run-late', state: 'failed', result: undefined, durationMs: null }))
    expect(panel()?.textContent).toContain('本次执行没有可用的结构化结果')
    expect(panel()?.textContent).not.toContain('肉鸽结算：第 5 层 · 得分 1200')

    await renderPanel(run({ runId: 'run-late', state: 'failed', result: { summary: summary() } }))
    const text = panel()?.textContent ?? ''
    expect(text).toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(text).toContain('耗时')
    expect(text).not.toContain('本次执行没有可用的结构化结果')

    await renderPanel(activeRun('run-next', '正在执行：第 1 层'))
    const nextText = panel()?.textContent ?? ''
    expect(nextText).toContain('上次执行结果')
    expect(nextText).toContain('肉鸽结算：第 5 层 · 得分 1200')
    expect(nextText).not.toContain('上一次执行没有可用的结构化结果')
  })

  it('shows the owning task in the body instead of the heading', async () => {
    await renderPanel(activeRun('run-2', '正在执行：第 3 层'), '集成战略')

    const text = panel()?.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('任务：集成战略')
    expect(text).not.toContain('任务归属未知')
    expect(panel()?.querySelector('.roguelike-panel-heading')?.textContent).not.toContain('集成战略')
    expect(panel()?.querySelector('.roguelike-panel-body')?.textContent).toContain('任务：集成战略')
  })

  it('states unknown task ownership instead of guessing from the page mode', async () => {
    await renderPanel(run(), null)

    const text = panel()?.textContent ?? ''
    expect(text).not.toContain('最近一次执行')
    expect(text).toContain('任务归属未知（刷新前发起）')
  })

  it('renders the status as a non-interactive badge', async () => {
    await renderPanel(run())

    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.textContent).toBe('成功')
    expect(badge?.tagName).not.toBe('BUTTON')
    expect(badge?.closest('button')).toBeNull()
  })

  it('separates only the retained result with a decorative separator', async () => {
    await renderPanel(run())
    await renderPanel(activeRun('run-2', '正在执行：第 1 层'))

    const separators = [...(panel()?.querySelectorAll('[data-slot="separator"]') ?? [])]
    expect(separators).toHaveLength(1)
    expect(separators.every(separator => separator.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(panel()?.querySelector('[data-testid="runtime-diagnostics"]')).toBeNull()
  })
})
