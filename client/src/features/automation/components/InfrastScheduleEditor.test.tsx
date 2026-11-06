// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import type { InfrastScheduleDocument } from '../model/infrastSchedule'
import InfrastScheduleEditor from './InfrastScheduleEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  listInfrastSchedules: vi.fn(),
  readInfrastSchedule: vi.fn(),
  saveInfrastSchedule: vi.fn(),
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
  getActivity: vi.fn(),
  getNotificationConfig: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  listInfrastSchedules: mocks.listInfrastSchedules,
  readInfrastSchedule: mocks.readInfrastSchedule,
  saveInfrastSchedule: mocks.saveInfrastSchedule,
}))

const userDocument = {
  author: 'uye',
  custom_top_field: { keep: true },
  layout: [{ type: 'trading', level: 3 }],
  plans: [{
    name: '早班',
    custom_plan_field: 1,
    Fiammetta: { enable: false },
    drones: { room: 'manufacture', index: 1 },
    rooms: {
      manufacture: [{ operators: ['芬'], custom_room: 'a' }],
      training: [{ operatorsA: ['杜宾'], operatorsB: ['银灰'] }],
      recycle: [{ skip: true }],
      future_room: [{ operators: ['未来干员'] }],
    },
  }],
}

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const buttonByText = (text: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`missing button: ${text}`)
  return button
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const inputByLabel = (label: string) => {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!element) throw new Error(`missing input: ${label}`)
  return element
}

const controlByLabel = (label: string) => {
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`missing control: ${label}`)
  return element
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const renderEditor = async (props: {
  filename?: string
  initialPlanIndex?: number
  onSaved?: (target: { filename: string; planIndex: number }) => void
}) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <InfrastScheduleEditor
          filename={props.filename ?? ''}
          initialPlanIndex={props.initialPlanIndex ?? 0}
          onClose={vi.fn()}
          onSaved={props.onSaved ?? vi.fn()}
        />
      </QueryClientProvider>,
    )
  })
  await flush()
}

describe('InfrastScheduleEditor', () => {
  beforeEach(() => {
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
    mocks.listInfrastSchedules.mockReset().mockResolvedValue({
      success: true,
      data: {
        directory: '/tmp/maa/infrast',
        schedules: [{ name: 'base.json', title: '排班', planCount: 1, updatedAt: null, valid: true }],
      },
    })
    mocks.readInfrastSchedule.mockReset()
    mocks.saveInfrastSchedule.mockReset()
    client = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.style.overflow = ''
    client.clear()
    vi.restoreAllMocks()
  })

  it('loads an existing schedule and saves it back without touching untouched rooms', async () => {
    mocks.readInfrastSchedule.mockResolvedValue({
      success: true,
      data: { name: 'base.json', document: userDocument },
    })
    mocks.saveInfrastSchedule.mockResolvedValue({
      success: true,
      data: { name: 'base.json', planCount: 1 },
    })
    const onSaved = vi.fn()
    await renderEditor({ filename: 'base.json', onSaved })

    expect(inputByLabel('训练室房间 1训练位干员').value).toBe('银灰')
    expect(controlByLabel('回收站房间 1处理方式').value).toBe('skip')

    await click(buttonByText('保存'))

    expect(mocks.saveInfrastSchedule).toHaveBeenCalledWith('base.json', userDocument)
    expect(onSaved).toHaveBeenCalledWith({ filename: 'base.json', planIndex: 0 })
  })

  it('creates a new file with an explicitly requested minimal plan', async () => {
    mocks.saveInfrastSchedule.mockResolvedValue({
      success: true,
      data: { name: 'custom.json', planCount: 1 },
    })
    const onSaved = vi.fn()
    await renderEditor({ onSaved })

    expect(mocks.readInfrastSchedule).not.toHaveBeenCalled()
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="schedules/base.json"]')
    if (!nameInput) throw new Error('missing filename input')
    await setInputValue(nameInput, 'custom.json')
    await click(buttonByText('新建排班'))
    await click(buttonByText('保存'))

    const expected: InfrastScheduleDocument = { plans: [{ name: '方案 1', rooms: {} }] }
    expect(mocks.saveInfrastSchedule).toHaveBeenCalledWith('custom.json', expected)
    expect(onSaved).toHaveBeenCalledWith({ filename: 'custom.json', planIndex: 0 })
  })

  it('shows a missing-file error and still allows creating the file', async () => {
    mocks.readInfrastSchedule.mockRejectedValue(new Error('排班文件不存在'))
    await renderEditor({ filename: 'missing.json' })

    expect(document.body.textContent).toContain('排班文件不存在')
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="schedules/base.json"]')
    if (!nameInput) throw new Error('missing filename input')
    await click(buttonByText('新建排班'))
    expect(document.body.textContent).toContain('控制中枢')
  })
})
