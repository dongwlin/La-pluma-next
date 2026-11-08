// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotDetailTarget } from '../model/copilotDetail'
import type { CopilotQueueEntry } from '../model/copilotQueue'
import type { CombatCopilotQueueProjection } from './combatPanelTypes'
import CombatCopilotQueuePanel from './CombatCopilotQueuePanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detailTargets: Array<CopilotDetailTarget | null> = []

vi.mock('./CombatCopilotDetailLayer', () => ({
  default: ({ target }: { target: CopilotDetailTarget | null }) => {
    detailTargets.push(target)
    return null
  },
}))

const entry = (overrides: Partial<CopilotQueueEntry> = {}): CopilotQueueEntry => ({
  id: overrides.id ?? 'entry-a',
  source: overrides.source ?? 'link',
  uri: overrides.uri ?? 'prts://101',
  title: overrides.title ?? '作业一',
  addedAt: 1,
  ...overrides,
})

const queue = (overrides: Partial<CombatCopilotQueueProjection> = {}): CombatCopilotQueueProjection => ({
  entries: [entry()],
  selected: new Set(['entry-a']),
  setId: null,
  itemStatuses: new Map(),
  itemErrors: new Map(),
  submittedEntryIds: new Set(),
  isRunning: false,
  isSubmitting: false,
  isAdding: false,
  addingUri: null,
  automationAvailable: true,
  unavailableMessage: '',
  onToggle: () => {},
  onRemove: () => {},
  onMove: () => {},
  onClear: () => {},
  onExecute: () => {},
  onAddCurrent: () => {},
  onAddUri: () => {},
  ...overrides,
})

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const buttons = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))

const buttonByText = (container: HTMLElement, text: string) => buttons(container)
  .find(button => button.textContent?.trim() === text)

const buttonByLabel = (container: HTMLElement, label: string) => buttons(container)
  .find(button => button.getAttribute('aria-label') === label)

describe('CombatCopilotQueuePanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    detailTargets.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const renderPanel = async (props: Partial<CombatCopilotQueueProjection> = {}) => {
    await act(async () => {
      root.render(<CombatCopilotQueuePanel queue={queue(props)} />)
    })
  }

  it('shows the empty state and disables execution', async () => {
    await renderPanel({ entries: [], selected: new Set() })

    const panel = container.querySelector<HTMLElement>('section[aria-label="作业队列"]')
    expect(panel).not.toBeNull()
    expect(container.textContent).toContain('作业队列')
    expect(container.textContent).toContain('共 0 项')
    expect(container.textContent).toContain('队列为空')
    expect(container.textContent).toContain('输入作业集链接会自动展开到队列')
    expect(container.textContent).toContain('本地文件')
    expect(buttonByText(container, '执行队列')?.disabled).toBe(true)
    expect(buttonByText(container, '清空')?.disabled).toBe(true)
  })

  it('renders rows with sequence, stage, cost and source badges', async () => {
    await renderPanel({
      entries: [
        entry({ id: 'a', title: '关卡一', stage: 'TEST-1', apCost: 18, source: 'set', setId: '48990' }),
        entry({ id: 'b', title: '', stage: 'TEST-2', source: 'link', uri: 'prts://102' }),
        entry({ id: 'c', title: '', stage: undefined, fileName: 'local.json', source: 'file', uri: '/data/local.json' }),
      ],
      selected: new Set(['a', 'b', 'c']),
    })

    const rows = container.querySelectorAll('[role="listitem"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('关卡一')
    expect(rows[0]?.textContent).toContain('作业集 prts://s48990')
    expect(rows[0]?.textContent).toContain('TEST-1')
    expect(rows[0]?.textContent).toContain('理智 18')
    expect(rows[1]?.textContent).toContain('TEST-2')
    expect(rows[1]?.textContent).toContain('链接')
    expect(rows[2]?.textContent).toContain('local.json')
    expect(rows[2]?.textContent).toContain('本地')
    expect(container.textContent).toContain('已勾选 3 / 3 项')
    expect(buttonByText(container, '执行队列')?.disabled).toBe(false)
  })

  it('toggles rows and reports the checked count', async () => {
    const onToggle = vi.fn()
    await renderPanel({
      entries: [entry({ id: 'a' }), entry({ id: 'b', title: '作业二', uri: 'prts://102' })],
      selected: new Set(['a', 'b']),
      onToggle,
    })

    expect(container.textContent).toContain('已勾选 2 / 2 项')
    await click(buttonByLabel(container, '取消选择队列第 1 项 作业一')!)

    expect(onToggle).toHaveBeenCalledWith('a')
  })

  it('executes only when entries are checked and automation is available', async () => {
    const onExecute = vi.fn()
    await renderPanel({ selected: new Set(), onExecute })

    expect(buttonByText(container, '执行队列')?.disabled).toBe(true)
    await click(buttonByText(container, '执行队列')!)

    expect(onExecute).not.toHaveBeenCalled()

    await renderPanel({ onExecute })
    await click(buttonByText(container, '执行队列')!)

    expect(onExecute).toHaveBeenCalledOnce()

    await renderPanel({ automationAvailable: false, unavailableMessage: '自动化不可用', onExecute })
    const execute = buttonByText(container, '执行队列')
    expect(execute?.disabled).toBe(true)
    expect(execute?.title).toBe('自动化不可用')

    await renderPanel({ isRunning: true, onExecute })
    expect(buttonByText(container, '执行队列')?.disabled).toBe(true)
    expect(buttonByText(container, '清空')?.disabled).toBe(true)
  })

  it('moves and removes rows, disabling impossible directions', async () => {
    const onMove = vi.fn()
    const onRemove = vi.fn()
    await renderPanel({
      entries: [entry({ id: 'a' }), entry({ id: 'b', title: '作业二', uri: 'prts://102' })],
      selected: new Set(['a', 'b']),
      onMove,
      onRemove,
    })

    expect(buttonByLabel(container, '上移第 1 项 作业一')?.disabled).toBe(true)
    expect(buttonByLabel(container, '下移第 2 项 作业二')?.disabled).toBe(true)

    await click(buttonByLabel(container, '下移第 1 项 作业一')!)
    await click(buttonByLabel(container, '上移第 2 项 作业二')!)
    await click(buttonByLabel(container, '删除第 1 项 作业一')!)

    expect(onMove).toHaveBeenNthCalledWith(1, 'a', 'down')
    expect(onMove).toHaveBeenNthCalledWith(2, 'b', 'up')
    expect(onRemove).toHaveBeenCalledWith('a')
  })

  it('opens the detail layer with the mapped target', async () => {
    await renderPanel({
      entries: [entry({
        id: 'a',
        title: '关卡一',
        stage: 'TEST-1',
        stageId: 'test_1',
        apCost: 18,
        uri: 'prts://101',
        source: 'set',
        setId: '48990',
        presetFormation: true,
        supportsRaid: false,
        completedModes: ['normal'],
        operators: ['能天使'],
        operatorDetails: [{ name: '能天使', elite: 2, level: 60 }],
        groups: ['重装'],
      })],
    })

    const body = buttonByLabel(container, '查看队列第 1 项详情 关卡一')!
    expect(body.getAttribute('aria-expanded')).toBe('false')
    await click(body)

    expect(body.getAttribute('aria-expanded')).toBe('true')
    const target = detailTargets[detailTargets.length - 1]
    expect(target).toMatchObject({
      title: '关卡一',
      stage: 'TEST-1',
      stageId: 'test_1',
      apCost: 18,
      sourceLabel: '作业集 prts://s48990',
      uri: 'prts://101',
      presetFormation: true,
      supportsRaid: false,
      completedModes: ['normal'],
      operators: [{ name: '能天使', elite: 2, level: 60 }],
      groups: ['重装'],
      statusLabel: '待执行',
    })
  })

  it('passes the failed status and complete failure reason to the detail target', async () => {
    await renderPanel({
      entries: [entry({
        id: 'a',
        title: '关卡一',
        stage: 'TEST-1',
        source: 'set',
        setId: '48990',
        setItemIndex: 0,
      })],
      setId: '48990',
      itemStatuses: new Map([[0, 'failed']]),
      itemErrors: new Map([[0, '缺少干员：桃金娘\n请检查 box 后重试']]),
    })

    await click(buttonByLabel(container, '查看队列第 1 项详情 关卡一')!)

    expect(detailTargets[detailTargets.length - 1]).toMatchObject({
      statusLabel: '待重试',
      error: '缺少干员：桃金娘\n请检查 box 后重试',
    })
  })

  it('maps set-backed rows to run statuses and custom rows to submitted state', async () => {
    const entries = [
      entry({ id: 's0', source: 'set', setId: '48990', setItemIndex: 0, title: '关卡一' }),
      entry({ id: 's1', source: 'set', setId: '48990', setItemIndex: 1, title: '关卡二' }),
      entry({ id: 'custom', title: '自定义作业', uri: 'prts://900' }),
    ]
    await renderPanel({
      entries,
      selected: new Set(['s0', 's1', 'custom']),
      setId: '48990',
      itemStatuses: new Map([[0, 'success'], [1, 'failed']]),
      submittedEntryIds: new Set(['custom']),
      isRunning: true,
    })

    const rows = () => container.querySelectorAll('[role="listitem"]')
    expect(rows()[0]?.textContent).toContain('已完成')
    expect(rows()[1]?.textContent).toContain('待重试')
    expect(rows()[2]?.textContent).toContain('本次已提交')

    await renderPanel({
      entries,
      selected: new Set(['s0', 's1', 'custom']),
      setId: '48990',
      itemStatuses: new Map([[0, 'success'], [1, 'failed']]),
      submittedEntryIds: new Set(['custom']),
    })

    expect(rows()[0]?.textContent).toContain('已完成')
    expect(rows()[2]?.textContent).toContain('待执行')
  })
})
