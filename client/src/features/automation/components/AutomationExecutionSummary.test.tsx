// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutomationExecutionSummary from './AutomationExecutionSummary'
import type { AutomationExecutionSummary as AutomationExecutionSummaryData } from '../model/automationRun'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const motionComponent = (tag: 'div') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as ReactNode),
  )

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: motionComponent('div') },
    useReducedMotion: () => true,
  }
})

const summary = (
  overrides: Partial<AutomationExecutionSummaryData> = {},
): AutomationExecutionSummaryData => ({
  successCount: 3,
  failedCount: 0,
  skippedCount: 0,
  durationMs: 65_000,
  summaries: [],
  reports: [],
  actions: [],
  errors: [],
  warnings: [],
  ...overrides,
})

const failedSummary = () => summary({
  successCount: 2,
  failedCount: 1,
  errors: [{ task: '理智作战', error: '关卡不可用' }],
})

let container: HTMLDivElement
let root: Root

const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}

const detailsButton = () => container.querySelector<HTMLButtonElement>('[aria-label="展开执行详情"], [aria-label="收起执行详情"]')

describe('AutomationExecutionSummary', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders nothing until the first summary arrives', async () => {
    await render(<AutomationExecutionSummary summary={null} runId={null} />)

    expect(container.querySelector('[aria-label="最近执行结果"]')).toBeNull()
  })

  it('keeps the last summary while a new submission clears the projection', async () => {
    await render(<AutomationExecutionSummary summary={summary()} runId="run-1" />)
    expect(container.textContent).toContain('最近执行')
    expect(container.textContent).toContain('成功 3')

    await render(<AutomationExecutionSummary summary={null} runId="run-1" />)

    expect(container.textContent).toContain('最近执行')
    expect(container.textContent).toContain('成功 3')
  })

  it('opens failures, preserves a manual collapse, and reopens for a new run', async () => {
    await render(<AutomationExecutionSummary summary={failedSummary()} runId="run-1" />)

    expect(detailsButton()?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('理智作战：关卡不可用')

    await act(async () => detailsButton()?.click())
    expect(detailsButton()?.getAttribute('aria-expanded')).toBe('false')

    // 同一 run 的同一内容重复到达，不覆盖用户手动收起。
    await render(<AutomationExecutionSummary summary={failedSummary()} runId="run-1" />)
    expect(detailsButton()?.getAttribute('aria-expanded')).toBe('false')

    // 新一次执行即使内容相同，也按本次结果重新展开。
    await render(<AutomationExecutionSummary summary={failedSummary()} runId="run-2" />)
    expect(detailsButton()?.getAttribute('aria-expanded')).toBe('true')
  })

  it('renders stage reports and warnings in the expanded details', async () => {
    await render(
      <AutomationExecutionSummary
        summary={summary({
          summaries: [{ task: '理智作战', stage: '1-7', times: '3', drops: '源岩 2' }],
          reports: [{ provider: 'penguin', stage: '1-7', status: 'success', message: '已上传' }],
          warnings: ['当前活动已结束'],
        })}
        runId="run-1"
      />,
    )
    await act(async () => detailsButton()?.click())

    expect(container.textContent).toContain('1-7')
    expect(container.textContent).toContain('3 次')
    expect(container.textContent).toContain('源岩 2')
    expect(container.textContent).toContain('已上传')
    expect(container.textContent).toContain('当前活动已结束')
  })
})
