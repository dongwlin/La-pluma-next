// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrainingOperator, TrainingPlan, TrainingQueueItem, TrainingSettings } from '@/shared/types/components'
import OperatorTraining from './OperatorTraining'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getOperatorList: vi.fn(),
  getAllOperators: vi.fn(),
  getOperBoxData: vi.fn(),
  getTrainingQueue: vi.fn(),
  addToTrainingQueue: vi.fn(),
  removeFromTrainingQueue: vi.fn(),
  updateTrainingQueueOrder: vi.fn(),
  updateTrainingSettings: vi.fn(),
  generateTrainingPlan: vi.fn(),
  applyTrainingPlan: vi.fn(),
  retryTrainingSync: vi.fn(),
  setMessage: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const motionComponent = (tag: 'button' | 'div' | 'span') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, whileHover: _whileHover, whileTap: _whileTap, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as ReactNode),
  )
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: {
      button: motionComponent('button'),
      div: motionComponent('div'),
      span: motionComponent('span'),
    },
    useReducedMotion: () => true,
  }
})

vi.mock('@/shared/api', () => ({
  getOperatorList: mocks.getOperatorList,
  getAllOperators: mocks.getAllOperators,
  getOperBoxData: mocks.getOperBoxData,
  getTrainingQueue: mocks.getTrainingQueue,
  addToTrainingQueue: mocks.addToTrainingQueue,
  removeFromTrainingQueue: mocks.removeFromTrainingQueue,
  updateTrainingQueueOrder: mocks.updateTrainingQueueOrder,
  updateTrainingSettings: mocks.updateTrainingSettings,
  generateTrainingPlan: mocks.generateTrainingPlan,
  applyTrainingPlan: mocks.applyTrainingPlan,
  retryTrainingSync: mocks.retryTrainingSync,
  getItemIconUrl: (id: string | number) => `/items/${id}.png`,
}))

vi.mock('../store/statusStore', () => ({
  useStatusStore: () => ({ setMessage: mocks.setMessage }),
}))

vi.mock('./FloatingStatusIndicator', () => ({ default: () => null }))

let container: HTMLDivElement
let root: Root

const settings: TrainingSettings = {
  useMedicine: 0,
  useStone: 0,
  autoSwitch: true,
  notifyOnComplete: true,
}

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

const queueItem = (operatorId: string, name: string): TrainingQueueItem => ({
  operatorId,
  operator: { name, rarity: 6, profession: 'SNIPER' },
  currentElite: 1,
  targetElite: 2,
  materials: [],
  progress: 25,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const plan = (): TrainingPlan & { queueRevision: string } => ({
  mode: 'current',
  queueRevision: 'queue-1',
  focusOperator: { id: 'char_current', name: '阿米娅', rarity: 6 },
  stages: [{ stage: '1-7', totalTimes: 5, sanityPerRun: 6, isOpen: true }],
  openStages: [{ stage: '1-7', totalTimes: 5, isOpen: true }],
  totalSanity: 30,
})

const queueResponse = (queue: TrainingQueueItem[], revision = 'queue-1') => ({
  success: true,
  data: {
    queue: [...queue],
    settings,
    revision,
    flowSync: { status: 'not_applied', flowName: '自动任务', taskName: 'Fight' },
  },
})

const mockMutableQueue = (initialQueue: TrainingQueueItem[]) => {
  let queue = [...initialQueue]
  mocks.getTrainingQueue.mockImplementation(async () => queueResponse(queue))
  mocks.removeFromTrainingQueue.mockImplementation(async (operatorId: string) => {
    queue = queue.filter(item => item.operatorId !== operatorId)
    return { success: true, data: { queueUpdated: true, queueRevision: 'queue-2' } }
  })
  mocks.addToTrainingQueue.mockImplementation(async (data: { operatorId: string; position?: number }) => {
    const item = initialQueue.find(candidate => candidate.operatorId === data.operatorId)
      ?? queueItem(data.operatorId, data.operatorId === 'char_added' ? '能天使' : data.operatorId)
    queue.splice(data.position ?? queue.length, 0, item)
    return { success: true, data: { queueUpdated: true, queueRevision: 'queue-2' } }
  })
  mocks.updateTrainingQueueOrder.mockImplementation(async (operatorIds: string[]) => {
    queue = operatorIds.map(operatorId => queue.find(item => item.operatorId === operatorId)!)
    return { success: true, data: { queueUpdated: true, queueRevision: 'queue-2' } }
  })
  return () => queue
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const renderComponent = async () => {
  await act(async () => {
    root.render(<OperatorTraining />)
  })
  await flush()
}

const switchByLabel = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${label}"]`)

const buttonWithText = (text: string, scope: ParentNode = document) => {
  const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.trim() === text)
  expect(button, `button with text "${text}"`).toBeDefined()
  return button!
}

const queueButton = (label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button, `queue button "${label}"`).not.toBeNull()
  return button!
}

const queueOrder = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="移除"]'))
  .map(button => button.getAttribute('aria-label')?.replace(/^移除/, ''))

const openPicker = async () => {
  const opener = buttonWithText('添加干员', container)
  opener.focus()
  await click(opener)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  return { opener, dialog: dialog! }
}

describe('OperatorTraining queue workspace', () => {
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
    mocks.getOperatorList.mockReset().mockResolvedValue({ success: true, data: { operators: [] } })
    mocks.getAllOperators.mockReset().mockResolvedValue({ success: true, data: { operators: [] } })
    mocks.getOperBoxData.mockReset().mockResolvedValue({ success: true, data: { data: [] } })
    mocks.getTrainingQueue.mockReset().mockResolvedValue(queueResponse([]))
    mocks.addToTrainingQueue.mockReset()
    mocks.removeFromTrainingQueue.mockReset()
    mocks.updateTrainingQueueOrder.mockReset().mockResolvedValue({ success: true })
    mocks.updateTrainingSettings.mockReset()
    mocks.generateTrainingPlan.mockReset().mockResolvedValue({ success: true, data: plan() })
    mocks.applyTrainingPlan.mockReset().mockResolvedValue({ success: true, data: { stageCount: 1 } })
    mocks.retryTrainingSync.mockReset()
    mocks.setMessage.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the operator picker on demand and returns keyboard focus to its opener', async () => {
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([queueItem('char_current', '阿米娅')]))

    await renderComponent()

    expect(container.querySelector('.ios-workspace-page[data-page="training"]')).not.toBeNull()
    expect(queueOrder()).toEqual(['阿米娅'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('input[aria-label="搜索干员名称"]')).toBeNull()
    expect(container.textContent).toContain('材料筹备进度')

    const { opener, dialog } = await openPicker()
    expect(dialog.querySelector('input[aria-label="搜索干员名称"]')).not.toBeNull()
    expect(dialog.contains(document.activeElement)).toBe(true)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(queueOrder()).toEqual(['阿米娅'])
  })

  it('shows retryable errors instead of empty states when initial reads fail', async () => {
    mocks.getOperatorList.mockRejectedValueOnce(new Error('干员服务暂不可用'))
    mocks.getTrainingQueue
      .mockRejectedValueOnce(new Error('队列服务暂不可用'))
      .mockResolvedValueOnce(queueResponse([]))

    await renderComponent()
    await openPicker()

    expect(document.body.textContent).toContain('干员列表加载失败')
    expect(document.body.textContent).toContain('干员服务暂不可用')
    expect(document.body.textContent).toContain('养成队列加载失败')
    expect(document.body.textContent).toContain('队列服务暂不可用')
    expect(document.body.textContent).not.toContain('没有可养成干员')
    expect(document.body.textContent).not.toContain('养成队列还是空的')

    const queueAlert = Array.from(container.querySelectorAll<HTMLElement>('[role="alert"]'))
      .find(alert => alert.textContent?.includes('队列服务暂不可用'))
    const queueRetry = queueAlert?.querySelector<HTMLButtonElement>('button')
    expect(queueRetry).not.toBeNull()
    await click(queueRetry!)

    expect(mocks.getTrainingQueue).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('队列服务暂不可用')
    expect(document.body.textContent).toContain('养成队列还是空的')
  })

  it('keeps the shared form controls in the picker, plan controls, and automation settings', async () => {
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([queueItem('char_current', '阿米娅')]))

    await renderComponent()
    const { dialog } = await openPicker()
    const search = dialog.querySelector<HTMLInputElement>('input[aria-label="搜索干员名称"]')
    const rarity = dialog.querySelector<HTMLSelectElement>('select[aria-label="稀有度"]')
    const planModeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="计划范围"]')
    expect(search?.className).toContain('app-native-control')
    expect(rarity?.className).toContain('app-native-control')
    expect(rarity?.querySelectorAll('option')).toHaveLength(4)
    expect(planModeSelect?.className).toContain('app-native-control')
    expect(planModeSelect?.querySelectorAll('option')).toHaveLength(2)
    expect(switchByLabel('自动切换')).not.toBeNull()
    expect(switchByLabel('完成通知')).not.toBeNull()
  })

  it('supports keyboard navigation of the operator scope inside the picker', async () => {
    await renderComponent()
    const { dialog } = await openPicker()

    const toolbar = dialog.querySelector<HTMLElement>('[role="toolbar"][aria-label="干员范围"]')
    expect(toolbar).not.toBeNull()
    const buttons = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    expect(buttons).toHaveLength(3)
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')

    const allButton = buttons.find(button => button.textContent?.includes('全部'))
    expect(allButton).toBeDefined()
    await click(allButton!)
    expect(allButton?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      allButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    await flush()

    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(buttons[0])
  })

  it('serializes settings writes so an older response cannot overwrite the latest value on disk', async () => {
    const firstRequest = deferred<{ success: boolean; data: TrainingSettings }>()
    mocks.updateTrainingSettings
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce({ success: true, data: settings })

    await renderComponent()
    const autoSwitch = switchByLabel('自动切换')
    expect(autoSwitch?.checked).toBe(true)

    await click(autoSwitch!)
    expect(autoSwitch?.checked).toBe(false)
    await click(autoSwitch!)
    expect(mocks.updateTrainingSettings).toHaveBeenCalledOnce()
    expect(autoSwitch?.checked).toBe(true)

    await act(async () => firstRequest.resolve({
      success: true,
      data: { ...settings, autoSwitch: false },
    }))
    await flush()

    expect(mocks.updateTrainingSettings).toHaveBeenCalledTimes(2)
    expect(mocks.updateTrainingSettings).toHaveBeenLastCalledWith(settings)
    expect(autoSwitch?.checked).toBe(true)
  })

  it('serializes duplicate queue additions while a request is pending and recovers from failure', async () => {
    const addRequest = deferred<{ success: boolean }>()
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_added', '能天使')] },
    })
    mocks.addToTrainingQueue.mockReturnValueOnce(addRequest.promise)

    await renderComponent()
    const { dialog } = await openPicker()
    const addButton = buttonWithText('添加', dialog)

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.addToTrainingQueue).toHaveBeenCalledOnce()
    expect(addButton.disabled).toBe(true)
    await act(async () => addRequest.resolve({ success: false }))
    await flush()

    expect(queueOrder()).toEqual([])
    expect(buttonWithText('添加', dialog).disabled).toBe(false)
    expect(mocks.setMessage).toHaveBeenCalledWith(expect.stringContaining('添加失败'), 'error')
  })

  it('adds the first target without applying a task flow and requires an explicit preview and apply', async () => {
    mockMutableQueue([])
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_added', '能天使')] },
    })

    await renderComponent()
    const { dialog } = await openPicker()
    await click(buttonWithText('添加', dialog))

    expect(queueOrder()).toEqual(['能天使'])
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
    expect(buttonWithText('已添加', dialog).disabled).toBe(true)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    await click(buttonWithText('预览刷图计划', container))
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
    await click(buttonWithText('应用到自动任务', container))
    expect(mocks.applyTrainingPlan).toHaveBeenCalledOnce()
    expect(mocks.applyTrainingPlan).toHaveBeenCalledWith({
      plan: expect.objectContaining({ queueRevision: 'queue-1', stages: plan().openStages }),
      settings,
    })
  })

  it('removes the only target to the empty state and restores it at the original position', async () => {
    const getQueue = mockMutableQueue([queueItem('char_current', '阿米娅')])

    await renderComponent()
    await click(queueButton('移除阿米娅'))

    expect(queueOrder()).toEqual([])
    expect(container.textContent).toContain('养成队列还是空的')
    expect(document.body.textContent).toContain('已移除 阿米娅')
    await click(buttonWithText('撤销'))

    expect(mocks.addToTrainingQueue).toHaveBeenCalledWith({
      operatorId: 'char_current',
      currentElite: 1,
      targetElite: 2,
      position: 0,
    })
    expect(mocks.updateTrainingQueueOrder).not.toHaveBeenCalled()
    expect(getQueue().map(item => item.operatorId)).toEqual(['char_current'])
    expect(queueOrder()).toEqual(['阿米娅'])
    expect(document.body.textContent).not.toContain('已移除 阿米娅')
  })

  it('keeps undo in a dismissible toast outside the queue workspace', async () => {
    mockMutableQueue([queueItem('char_current', '阿米娅')])

    await renderComponent()
    await click(queueButton('移除阿米娅'))

    const toast = document.querySelector<HTMLElement>('.training-undo-toast')
    expect(toast).not.toBeNull()
    expect(container.contains(toast)).toBe(false)
    expect(buttonWithText('撤销', toast!)).toBeDefined()
    const close = toast?.querySelector<HTMLButtonElement>('button[aria-label="关闭移除提示"]')
    expect(close).not.toBeNull()
    await click(close!)

    expect(document.querySelector('.training-undo-toast')).toBeNull()
    expect(queueOrder()).toEqual([])
    expect(mocks.addToTrainingQueue).not.toHaveBeenCalled()
  })

  it('expires the undo toast after eight seconds and pauses expiry while it has keyboard focus', async () => {
    mockMutableQueue([queueItem('char_current', '阿米娅')])

    await renderComponent()
    vi.useFakeTimers()
    await click(queueButton('移除阿米娅'))
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(document.querySelector('.training-undo-toast')).not.toBeNull()

    const undoButton = buttonWithText('撤销')
    await act(async () => undoButton.focus())
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(document.querySelector('.training-undo-toast')).not.toBeNull()

    await act(async () => undoButton.blur())
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(document.querySelector('.training-undo-toast')).toBeNull()
    expect(queueOrder()).toEqual([])
  })

  it('promotes the next target when the current target is removed', async () => {
    mockMutableQueue([
      queueItem('char_current', '阿米娅'),
      queueItem('char_next', '能天使'),
      queueItem('char_last', '艾雅法拉'),
    ])

    await renderComponent()
    expect(container.querySelector('button[aria-label="将阿米娅设为当前"]')).toBeNull()
    await click(queueButton('移除阿米娅'))

    expect(queueOrder()).toEqual(['能天使', '艾雅法拉'])
    expect(container.querySelector('button[aria-label="将能天使设为当前"]')).toBeNull()
    expect(queueButton('将艾雅法拉设为当前')).not.toBeNull()
  })

  it('restores a removed middle target at its original index with one atomic add', async () => {
    const getQueue = mockMutableQueue([
      queueItem('char_current', '阿米娅'),
      queueItem('char_removed', '能天使'),
      queueItem('char_last', '艾雅法拉'),
    ])

    await renderComponent()
    await click(queueButton('移除能天使'))
    expect(queueOrder()).toEqual(['阿米娅', '艾雅法拉'])
    await click(buttonWithText('撤销'))

    expect(mocks.addToTrainingQueue).toHaveBeenCalledWith({
      operatorId: 'char_removed',
      currentElite: 1,
      targetElite: 2,
      position: 1,
    })
    expect(mocks.updateTrainingQueueOrder).not.toHaveBeenCalled()
    expect(getQueue().map(item => item.operatorId)).toEqual(['char_current', 'char_removed', 'char_last'])
    expect(queueOrder()).toEqual(['阿米娅', '能天使', '艾雅法拉'])
  })

  it('sets a later target as current without dropping any other target', async () => {
    mockMutableQueue([
      queueItem('char_current', '阿米娅'),
      queueItem('char_middle', '能天使'),
      queueItem('char_last', '艾雅法拉'),
    ])

    await renderComponent()
    const setCurrentButton = queueButton('将艾雅法拉设为当前')
    setCurrentButton.focus()
    await click(setCurrentButton)

    expect(mocks.updateTrainingQueueOrder).toHaveBeenCalledWith(['char_last', 'char_current', 'char_middle'])
    expect(queueOrder()).toEqual(['艾雅法拉', '阿米娅', '能天使'])
    expect(container.querySelector('button[aria-label="将艾雅法拉设为当前"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('#training-queue-title'))
  })

  it('keeps keyboard-accessible move controls at both queue boundaries', async () => {
    mockMutableQueue([
      queueItem('char_current', '阿米娅'),
      queueItem('char_middle', '能天使'),
      queueItem('char_last', '艾雅法拉'),
    ])

    await renderComponent()
    expect(queueButton('上移阿米娅').disabled).toBe(true)
    expect(queueButton('下移艾雅法拉').disabled).toBe(true)
    expect(queueButton('上移能天使').disabled).toBe(false)
    expect(queueButton('下移能天使').disabled).toBe(false)
    await click(queueButton('上移能天使'))

    expect(mocks.updateTrainingQueueOrder).toHaveBeenLastCalledWith(['char_middle', 'char_current', 'char_last'])
    expect(queueOrder()).toEqual(['能天使', '阿米娅', '艾雅法拉'])
    await click(queueButton('下移能天使'))
    expect(mocks.updateTrainingQueueOrder).toHaveBeenLastCalledWith(['char_current', 'char_middle', 'char_last'])
    expect(queueOrder()).toEqual(['阿米娅', '能天使', '艾雅法拉'])
  })

  it('keeps the queue unchanged and allows retry when a removal fails', async () => {
    mockMutableQueue([queueItem('char_current', '阿米娅')])
    mocks.removeFromTrainingQueue.mockResolvedValueOnce({ success: false })

    await renderComponent()
    await click(queueButton('移除阿米娅'))

    expect(queueOrder()).toEqual(['阿米娅'])
    expect(queueButton('移除阿米娅').disabled).toBe(false)
    expect(mocks.setMessage).toHaveBeenCalledWith(expect.stringContaining('删除失败'), 'error')
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '撤销')).toBe(false)
    await click(queueButton('移除阿米娅'))
    expect(queueOrder()).toEqual([])
  })

  it('invalidates an old preview as soon as a queue change starts', async () => {
    const removeRequest = deferred<{ success: boolean }>()
    mockMutableQueue([queueItem('char_current', '阿米娅'), queueItem('char_next', '能天使')])
    mocks.removeFromTrainingQueue.mockReturnValueOnce(removeRequest.promise)

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))
    const oldApplyButton = buttonWithText('应用到自动任务', container)
    await click(queueButton('移除阿米娅'))

    expect(container.contains(oldApplyButton) && !oldApplyButton.disabled).toBe(false)
    await click(oldApplyButton)
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
    await act(async () => removeRequest.resolve({ success: false }))
    await flush()
    expect(queueOrder()).toEqual(['阿米娅', '能天使'])
    expect(container.textContent).not.toContain('1-7')
  })

  it('invalidates an old preview when its scope changes', async () => {
    mockMutableQueue([queueItem('char_current', '阿米娅')])

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))
    expect(buttonWithText('应用到自动任务', container)).toBeDefined()
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="计划范围"]')!
    await act(async () => {
      mode.value = 'all'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).not.toContain('1-7')
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.trim() === '应用到自动任务')).toBe(false)
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
  })

  it('refreshes an externally advanced queue before generating a preview for its current target', async () => {
    const current = queueItem('char_current', '阿米娅')
    const next = queueItem('char_next', '能天使')
    const refreshRequest = deferred<ReturnType<typeof queueResponse>>()
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([current, next]))

    await renderComponent()
    mocks.getTrainingQueue.mockReturnValueOnce(refreshRequest.promise)
    mocks.generateTrainingPlan.mockResolvedValue({
      success: true,
      data: { ...plan(), queueRevision: 'queue-2', focusOperator: { id: 'char_next', name: '能天使', rarity: 6 } },
    })
    await click(buttonWithText('预览刷图计划', container))

    expect(mocks.generateTrainingPlan).not.toHaveBeenCalled()
    expect(queueButton('移除阿米娅').disabled).toBe(true)
    await act(async () => refreshRequest.resolve(queueResponse([next], 'queue-2')))
    await flush()

    expect(mocks.generateTrainingPlan).toHaveBeenCalledOnce()
    expect(queueOrder()).toEqual(['能天使'])
    expect(container.querySelector('#training-materials-title')?.textContent).toBe('能天使的材料')
    expect(container.querySelector('.training-plan-overview h3')?.textContent).toBe('能天使')
    expect(buttonWithText('应用到自动任务', container).disabled).toBe(false)
  })

  it('rejects a preview generated across queue revisions and refreshes the queue before retry', async () => {
    const current = queueItem('char_current', '阿米娅')
    const next = queueItem('char_next', '能天使')
    const previewRequest = deferred<{ success: boolean; data: TrainingPlan }>()
    const newerPlan = { ...plan(), queueRevision: 'queue-2', focusOperator: { id: 'char_next', name: '能天使', rarity: 6 } }
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([current, next]))
    mocks.generateTrainingPlan.mockReturnValueOnce(previewRequest.promise)

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))
    expect(mocks.generateTrainingPlan).toHaveBeenCalledOnce()
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([next], 'queue-2'))
    await act(async () => previewRequest.resolve({ success: true, data: newerPlan }))
    await flush()

    expect(mocks.getTrainingQueue).toHaveBeenCalledTimes(3)
    expect(queueOrder()).toEqual(['能天使'])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('养成队列已变化，请重新预览计划')
    expect(container.querySelector('.training-plan-overview')).toBeNull()
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
    mocks.generateTrainingPlan.mockResolvedValueOnce({ success: true, data: newerPlan })
    await click(buttonWithText('预览刷图计划', container))

    expect(mocks.generateTrainingPlan).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(buttonWithText('应用到自动任务', container).disabled).toBe(false)
  })

  it('invalidates an existing preview when sync retry discovers an external queue revision', async () => {
    const current = queueItem('char_current', '阿米娅')
    const next = queueItem('char_next', '能天使')
    const failedQueue = queueResponse([current, next])
    mocks.getTrainingQueue.mockResolvedValue({
      ...failedQueue,
      data: {
        ...failedQueue.data,
        flowSync: { status: 'failed', flowName: '自动任务', taskName: 'Fight', error: '同步尚未完成' },
      },
    })
    mocks.retryTrainingSync.mockResolvedValue({
      success: true,
      data: { flowSync: { status: 'synced', flowName: '自动任务', taskName: 'Fight', syncedRevision: 'queue-2' } },
    })

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))
    const oldApplyButton = buttonWithText('应用到自动任务', container)
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([next], 'queue-2'))
    await click(buttonWithText('重试同步', container))

    expect(mocks.getTrainingQueue).toHaveBeenCalledTimes(3)
    expect(queueOrder()).toEqual(['能天使'])
    expect(container.contains(oldApplyButton)).toBe(false)
    expect(container.querySelector('.training-plan-overview')).toBeNull()
    await click(oldApplyButton)
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已同步到自动任务')
  })

  it('prevents duplicate previews and blocks queue changes while generating', async () => {
    const previewRequest = deferred<{ success: boolean; data: TrainingPlan }>()
    mockMutableQueue([queueItem('char_current', '阿米娅')])
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_added', '能天使'), operator('char_other', '艾雅法拉')] },
    })
    mocks.generateTrainingPlan.mockReturnValueOnce(previewRequest.promise)

    await renderComponent()
    const previewButton = buttonWithText('预览刷图计划', container)
    await act(async () => {
      previewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      previewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(mocks.generateTrainingPlan).toHaveBeenCalledOnce()
    expect(queueButton('移除阿米娅').disabled).toBe(true)
    const { dialog } = await openPicker()
    const addButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[aria-label^="添加"]'))
    expect(addButtons).toHaveLength(2)
    expect(addButtons.every(button => button.disabled)).toBe(true)
    await act(async () => previewRequest.resolve({ success: true, data: plan() }))
    await flush()
    expect(queueButton('移除阿米娅').disabled).toBe(false)
    expect(addButtons.every(button => !button.disabled)).toBe(true)
    expect(buttonWithText('应用到自动任务', container)).toBeDefined()
  })

  it('prevents duplicate applies and unlocks queue operations after a failed apply', async () => {
    const applyRequest = deferred<{ success: boolean }>()
    mockMutableQueue([queueItem('char_current', '阿米娅')])
    mocks.applyTrainingPlan.mockReturnValueOnce(applyRequest.promise)

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))
    const applyButton = buttonWithText('应用到自动任务', container)
    await act(async () => {
      applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(mocks.applyTrainingPlan).toHaveBeenCalledOnce()
    expect(queueButton('移除阿米娅').disabled).toBe(true)
    await act(async () => applyRequest.resolve({ success: false }))
    await flush()
    expect(queueButton('移除阿米娅').disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('应用失败')
    expect(buttonWithText('预览刷图计划', container).disabled).toBe(false)
    await click(buttonWithText('预览刷图计划', container))
    expect(buttonWithText('应用到自动任务', container).disabled).toBe(false)
  })

  it('shows a persistent sync failure separately from the updated queue and retries it', async () => {
    const syncedFlow = { status: 'synced', flowName: '日常刷图', taskName: 'Fight', syncedRevision: 'queue-1' }
    mocks.getTrainingQueue.mockResolvedValue({
      ...queueResponse([queueItem('char_current', '阿米娅')]),
      data: {
        ...queueResponse([queueItem('char_current', '阿米娅')]).data,
        flowSync: { status: 'failed', flowName: '日常刷图', taskName: 'Fight', error: '配置文件暂时不可写' },
      },
    })
    mocks.retryTrainingSync.mockResolvedValue({ success: true, data: { flowSync: syncedFlow } })

    await renderComponent()

    const status = Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'))
      .find(element => element.textContent?.includes('配置文件暂时不可写'))
    expect(status).toBeDefined()
    expect(queueOrder()).toEqual(['阿米娅'])
    await click(buttonWithText('重试同步', status))

    expect(mocks.retryTrainingSync).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('配置文件暂时不可写')
    expect(queueOrder()).toEqual(['阿米娅'])
  })

  it('distinguishes collected materials from a target that still has a material gap', async () => {
    const target = { ...queueItem('char_current', '阿米娅'), progress: 100 }
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([target]))

    await renderComponent()

    expect(container.textContent).toContain('当前目标材料已集齐，可在游戏内完成养成。')
    expect(container.querySelector('[role="table"][aria-label="材料筹备明细"]')).toBeNull()
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('shows a remaining LMD gap even when the target needs no other materials', async () => {
    const target = {
      ...queueItem('char_current', '阿米娅'),
      materials: [],
      lmd: { needed: 100000, have: 1234, stillNeeded: 98766 },
    }
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([target]))

    await renderComponent()

    const table = container.querySelector('[role="table"][aria-label="材料筹备明细"]')
    const quantities = Array.from(table?.querySelectorAll('[role="cell"]') ?? []).map(cell => cell.textContent)
    expect(quantities).toEqual(['龙门币', '1234', '100000', '98766'])
    expect(container.textContent).toContain('还缺 1 种材料')
    expect(container.textContent).not.toContain('材料已集齐')
  })

  it('keeps material quantities, closed-stage plans, and degraded data warnings distinct', async () => {
    const target = {
      ...queueItem('char_current', '阿米娅'),
      materials: [{ id: '30012', name: '固源岩', count: 3, have: 1, needed: 3, stillNeeded: 2 }],
    }
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([target]))
    mocks.generateTrainingPlan.mockResolvedValue({
      success: true,
      data: {
        ...plan(),
        stages: [{ stage: 'CA-5', totalTimes: 2, isOpen: false }],
        openStages: [],
        closedStages: [{ stage: 'CA-5', totalTimes: 2, isOpen: false }],
        warnings: ['掉落数据暂不可用，当前使用保守估算'],
      },
    })

    await renderComponent()
    const table = container.querySelector('[role="table"][aria-label="材料筹备明细"]')
    const quantities = Array.from(table?.querySelectorAll('[role="cell"]') ?? []).map(cell => cell.textContent)
    expect(quantities).toEqual(['固源岩', '1', '3', '2'])
    expect(container.textContent).not.toContain('当前目标材料已集齐')

    await click(buttonWithText('预览刷图计划', container))

    expect(container.textContent).toContain('今天没有可直接推进的开放关卡')
    expect(container.querySelector('[role="note"]')?.textContent).toContain('当前使用保守估算')
    expect(container.textContent).toContain('CA-5')
    expect(buttonWithText('应用到自动任务', container).disabled).toBe(true)
    expect(mocks.applyTrainingPlan).not.toHaveBeenCalled()
  })

  it('shows a failed preview as an error and lets the user retry it', async () => {
    mocks.getTrainingQueue.mockResolvedValue(queueResponse([queueItem('char_current', '阿米娅')]))
    mocks.generateTrainingPlan.mockResolvedValueOnce({ success: false, message: '掉落服务暂不可用' })

    await renderComponent()
    await click(buttonWithText('预览刷图计划', container))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('掉落服务暂不可用')
    expect(container.textContent).not.toContain('1-7')
    expect(buttonWithText('预览刷图计划', container).disabled).toBe(false)
    await click(buttonWithText('预览刷图计划', container))

    expect(mocks.generateTrainingPlan).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(buttonWithText('应用到自动任务', container).disabled).toBe(false)
  })

  it('ignores a slow initial queue response after a newer post-add refresh', async () => {
    const initialRequest = deferred<ReturnType<typeof queueResponse>>()
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_added', '能天使')] },
    })
    mocks.getTrainingQueue
      .mockReturnValueOnce(initialRequest.promise)
      .mockResolvedValueOnce(queueResponse([queueItem('char_current', '阿米娅'), queueItem('char_added', '能天使')]))
    mocks.addToTrainingQueue.mockResolvedValue({ success: true })

    await renderComponent()
    const { dialog } = await openPicker()
    await click(buttonWithText('添加', dialog))
    expect(queueOrder()).toEqual(['阿米娅', '能天使'])
    await act(async () => initialRequest.resolve({
      ...queueResponse([]),
      data: { ...queueResponse([]).data, settings: { ...settings, autoSwitch: false } },
    }))
    await flush()

    expect(queueOrder()).toEqual(['阿米娅', '能天使'])
    expect(switchByLabel('自动切换')?.checked).toBe(true)
  })

  it('keeps the local queue truthful and warns when a successful add cannot be refreshed', async () => {
    mocks.getOperatorList.mockResolvedValue({
      success: true,
      data: { operators: [operator('char_added', '能天使')] },
    })
    mocks.getTrainingQueue
      .mockResolvedValueOnce(queueResponse([]))
      .mockResolvedValueOnce({ success: false })
    mocks.addToTrainingQueue.mockResolvedValue({ success: true })

    await renderComponent()
    const { dialog } = await openPicker()
    await click(buttonWithText('添加', dialog))

    expect(queueOrder()).toEqual(['能天使'])
    expect(mocks.setMessage).toHaveBeenCalledWith(expect.stringContaining('队列刷新失败'), 'warning')
  })

  it('removes the local item and warns when a successful delete cannot be refreshed', async () => {
    mocks.getTrainingQueue
      .mockResolvedValueOnce(queueResponse([queueItem('char_current', '阿米娅'), queueItem('char_removed', '能天使')]))
      .mockResolvedValueOnce({ success: false })
    mocks.removeFromTrainingQueue.mockResolvedValue({ success: true })

    await renderComponent()
    await click(queueButton('移除能天使'))

    expect(queueOrder()).toEqual(['阿米娅'])
    expect(document.body.textContent).toContain('已移除 能天使')
    expect(mocks.setMessage).toHaveBeenCalledWith(expect.stringContaining('队列刷新失败'), 'warning')
  })
})
