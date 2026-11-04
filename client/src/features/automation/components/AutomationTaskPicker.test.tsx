// @vitest-environment jsdom

import { act, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationAvailableTask, TaskFlowItem } from '../types'
import AutomationTaskPicker from './AutomationTaskPicker'
import { AVAILABLE_TASKS } from './automationTaskCatalog'

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

const flowTask = (id: string): TaskFlowItem => ({
  id,
  commandId: 'fight',
  name: '理智作战',
  icon: null,
  description: '自动刷关卡消耗理智',
  defaultParams: {},
  paramFields: [],
  params: {},
  enabled: true,
})

const onAddTask = vi.fn<(task: AutomationAvailableTask) => void>()

let container: HTMLDivElement
let root: Root

function Host({ disabled = false, flow = [] as TaskFlowItem[] }: {
  disabled?: boolean
  flow?: TaskFlowItem[]
}) {
  const regionRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={regionRef} data-testid="footer-region">
      <AutomationTaskPicker
        flow={flow}
        disabled={disabled}
        onAddTask={onAddTask}
        regionRef={regionRef}
      />
      <button type="button">立即执行</button>
    </div>
  )
}

const trigger = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
const menu = () => container.querySelector<HTMLElement>('#automation-task-picker')

const openPicker = async () => {
  await act(async () => trigger().click())
}

const dispatchPointerDown = async (target: EventTarget) => {
  await act(async () => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
}

const stubTriggerRect = (
  element: HTMLButtonElement,
  rect: { top: number; bottom: number; left: number; width: number },
) => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.left + rect.width,
    width: rect.width,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  } as DOMRect)
}

describe('AutomationTaskPicker', () => {
  beforeEach(() => {
    onAddTask.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('anchors the menu above the footer when the viewport has room', async () => {
    await act(async () => root.render(<Host />))
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 844)
    stubTriggerRect(trigger(), { top: 400, bottom: 444, left: 24, width: 320 })

    await openPicker()

    const surface = menu()!
    expect(surface.dataset.placement).toBe('top')
    expect(surface.style.bottom).toBe(`${844 - 400 + 8}px`)
    expect(surface.style.top).toBe('')
    expect(surface.style.left).toBe('24px')
    expect(surface.style.width).toBe('320px')
    expect(surface.style.maxHeight).toBe('224px')
  })

  it('flips the menu below the trigger when the footer sits near the top edge', async () => {
    await act(async () => root.render(<Host />))
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 600)
    stubTriggerRect(trigger(), { top: 40, bottom: 84, left: 24, width: 320 })

    await openPicker()

    const surface = menu()!
    expect(surface.dataset.placement).toBe('bottom')
    expect(surface.style.top).toBe(`${84 + 8}px`)
    expect(surface.style.bottom).toBe('')
    expect(surface.style.maxHeight).toBe('224px')
  })

  it('keeps the menu inside the viewport width', async () => {
    await act(async () => root.render(<Host />))
    vi.stubGlobal('innerWidth', 360)
    vi.stubGlobal('innerHeight', 844)
    stubTriggerRect(trigger(), { top: 400, bottom: 444, left: 320, width: 200 })

    await openPicker()

    const surface = menu()!
    expect(surface.style.left).toBe('148px')
    expect(surface.style.width).toBe('200px')
  })

  it('adds a task through the page callback and closes the menu', async () => {
    await act(async () => root.render(<Host />))
    await openPicker()

    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(menu()?.getAttribute('role')).toBe('menu')
    expect(menu()?.getAttribute('aria-label')).toBe('可添加任务')
    expect(menu()?.querySelectorAll('[role="menuitem"]')).toHaveLength(AVAILABLE_TASKS.length)

    const fightOption = Array.from(menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(option => option.textContent?.includes('理智作战'))!
    await act(async () => fightOption.click())

    expect(onAddTask).toHaveBeenCalledOnce()
    expect(onAddTask.mock.calls[0]?.[0]).toMatchObject({ id: 'fight', name: '理智作战' })
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('counts existing flow rows in the menu', async () => {
    await act(async () => root.render(<Host flow={[flowTask('fight-1'), flowTask('fight-2')]} />))
    await openPicker()

    const fightOption = Array.from(menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(option => option.textContent?.includes('理智作战'))!
    expect(fightOption.textContent).toContain('2')
  })

  it('stays open for presses inside the shared footer and closes outside it', async () => {
    await act(async () => root.render(<Host />))
    await openPicker()

    const runButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === '立即执行')!
    await dispatchPointerDown(runButton)
    expect(menu()).not.toBeNull()

    await dispatchPointerDown(document.body)
    expect(menu()).toBeNull()
  })

  it('closes with Escape and restores trigger focus', async () => {
    await act(async () => root.render(<Host />))
    await openPicker()

    const firstMenuItem = menu()!.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    firstMenuItem.focus()
    expect(document.activeElement).toBe(firstMenuItem)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes and disables the picker when the flow can no longer be edited', async () => {
    await act(async () => root.render(<Host />))
    await openPicker()
    expect(menu()).not.toBeNull()

    await act(async () => root.render(<Host disabled />))

    expect(menu()).toBeNull()
    expect(trigger().disabled).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })
})
