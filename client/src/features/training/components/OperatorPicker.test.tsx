// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import type { TrainingOperator } from '../types'
import OperatorPicker from './OperatorPicker'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getOperatorList: vi.fn(),
  getAllOperators: vi.fn(),
  getOperBoxData: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: React.ReactNode }
  const motionComponent = (tag: 'button' | 'div' | 'span') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as React.ReactNode),
  )
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      button: motionComponent('button'),
      div: motionComponent('div'),
      span: motionComponent('span'),
    },
    useReducedMotion: () => true,
  }
})

vi.mock('../api', () => ({
  getOperatorList: mocks.getOperatorList,
  getTrainingQueue: vi.fn(),
}))

vi.mock('@/features/game-data/api', () => ({
  getAllOperators: mocks.getAllOperators,
  getDepotData: vi.fn(),
  getOperBoxData: mocks.getOperBoxData,
  getItemIconUrl: (id: string | number) => `/items/${id}.png`,
}))

const operator = (id: string, name: string): TrainingOperator => ({
  id,
  name,
  rarity: 6,
  profession: 'SNIPER',
  currentElite: 1,
  currentLevel: 80,
  targetElite: 2,
  owned: true,
  hasMaterialData: true,
  canTrain: true,
  disabledReason: null,
  trainingStatus: 'trainable',
})

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const typeSearch = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索干员名称"]')
  expect(input).not.toBeNull()
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const buttonWithText = (text: string): HTMLButtonElement | undefined => Array.from(
  document.querySelectorAll<HTMLButtonElement>('button'),
).find(candidate => candidate.textContent?.trim() === text)

// 卡片容器本身没有语义 role，用每张卡片唯一的“添加”按钮可访问名计数行数。
const renderedCards = () => document.querySelectorAll('[role="dialog"] button[aria-label^="添加"]').length

function Harness() {
  const [open, setOpen] = useState(true)
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开选择器</button>
    <OperatorPicker
      isOpen={open}
      onClose={() => setOpen(false)}
      queueOperatorIds={new Set<string>()}
      queueLength={0}
      busy={false}
      operationError={null}
      pendingOperatorIds={new Set<string>()}
      onAdd={vi.fn()}
    />
  </>
}

describe('training operator picker', () => {
  beforeEach(() => {
    mocks.getOperatorList.mockReset()
    mocks.getAllOperators.mockReset().mockResolvedValue({ success: true, data: [] })
    mocks.getOperBoxData.mockReset().mockResolvedValue({ success: true, data: { data: [] } })
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    client = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
    vi.restoreAllMocks()
  })

  it('filters rows by name and explains an empty search result', async () => {
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_amiya', '阿米娅'), operator('char_exusiai', '能天使')] },
    })

    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
    await flush()

    expect(renderedCards()).toBe(2)
    await typeSearch('  阿米  ')
    expect(renderedCards()).toBe(1)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('阿米娅')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('能天使')

    await typeSearch('不存在')
    expect(renderedCards()).toBe(0)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('没有找到符合条件的干员')

    await typeSearch('   ')
    expect(renderedCards()).toBe(2)
  })

  it('renders one batch at a time and appends the next batch on demand', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => operator(`char_${index}`, `干员${index}`))
    mocks.getOperatorList.mockResolvedValue({ success: true, data: { operators: rows } })

    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
    await flush()

    expect(renderedCards()).toBe(72)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已显示 72 / 80')

    await click(buttonWithText('继续显示 8 个')!)
    expect(renderedCards()).toBe(80)
    expect(buttonWithText('继续显示 80 个')).toBeUndefined()
  })

  it('keeps search and batch progress when the modal is closed and reopened', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => operator(`char_${index}`, `干员${index}`))
    mocks.getOperatorList.mockResolvedValue({ success: true, data: { operators: rows } })

    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
    await flush()

    await typeSearch('干员')
    await click(buttonWithText('继续显示 8 个')!)
    expect(renderedCards()).toBe(80)

    await click(buttonWithText('完成选择')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await click(buttonWithText('打开选择器')!)
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索干员名称"]')
    expect(input?.value).toBe('干员')
    expect(renderedCards()).toBe(80)
    expect(buttonWithText('继续显示 8 个')).toBeUndefined()
  })
})
