// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanelStateStore } from '../model/panelState'
import type { CopilotSearchResult } from '../types'
import CombatSearchPanel from './CombatSearchPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const result: CopilotSearchResult = {
  stage: '1-7',
  copilots: [
    { id: '1', uri: 'prts://1', title: '搜索结果作业', views: 0, hotScore: 0 },
    { id: '2', uri: 'prts://2', title: '另一个作业', views: 0, hotScore: 0 },
  ],
  recommended: { uri: 'prts://1' },
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CombatSearchPanel', () => {
  let container: HTMLDivElement
  let root: Root

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

  const renderPanel = async (overrides: Partial<Parameters<typeof CombatSearchPanel>[0]> = {}) => {
    await act(async () => {
      root.render(
        <CombatSearchPanel
          stageStore={createPanelStateStore('')}
          selectionStore={createPanelStateStore('')}
          result={result}
          searching={false}
          addingUri={null}
          candidates={[]}
          activeStage={null}
          onSearch={() => {}}
          onCancel={() => {}}
          onSelectStage={() => {}}
          onSelectUri={() => {}}
          onAddToQueue={() => {}}
          {...overrides}
        />,
      )
    })
  }

  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))

  it('keeps selecting a result separate from adding it to the queue', async () => {
    const onSelectUri = vi.fn()
    const onAddToQueue = vi.fn()
    await renderPanel({ onSelectUri, onAddToQueue })

    const resultButton = buttons().find(button => button.textContent?.includes('搜索结果作业'))
    expect(resultButton).not.toBeUndefined()
    expect(resultButton?.textContent).toContain('推荐')

    const addButtons = buttons().filter(button => button.textContent?.trim() === '加入队列')
    expect(addButtons).toHaveLength(2)
    expect(addButtons[0]?.getAttribute('aria-label')).toBe('加入队列: 搜索结果作业')

    await click(addButtons[1]!)
    expect(onAddToQueue).toHaveBeenCalledWith('prts://2')
    expect(onSelectUri).not.toHaveBeenCalled()

    await click(resultButton!)
    expect(onSelectUri).toHaveBeenCalledWith('prts://1')
  })

  it('marks the active result and disables its add button while adding', async () => {
    const onAddToQueue = vi.fn()
    await renderPanel({
      selectionStore: createPanelStateStore('prts://1'),
      addingUri: 'prts://1',
      onAddToQueue,
    })

    const activeResult = buttons().find(button => button.textContent?.includes('搜索结果作业'))
    expect(activeResult?.textContent).toContain('搜索结果作业')
    expect(activeResult?.textContent).toContain('已选中')

    const adding = buttons().find(button => button.textContent?.trim() === '加入中')
    expect(adding?.disabled).toBe(true)
    const other = buttons().filter(button => button.textContent?.trim() === '加入队列')
    expect(other).toHaveLength(1)
    await click(other[0]!)

    expect(onAddToQueue).toHaveBeenCalledWith('prts://2')
  })

  it('renders every returned result instead of truncating the list', async () => {
    const many: CopilotSearchResult = {
      stage: '1-7',
      copilots: Array.from({ length: 6 }, (_, index) => ({
        id: String(index + 1),
        uri: `prts://${index + 1}`,
        title: `作业${index + 1}`,
        views: 0,
        hotScore: 0,
      })),
    }
    await renderPanel({ result: many })

    const addButtons = buttons().filter(button => button.textContent?.trim() === '加入队列')
    expect(addButtons).toHaveLength(6)
  })

  it('lets the caller pick one of several stages for an ambiguous code', async () => {
    const onSelectStage = vi.fn()
    const candidates = [
      { stageId: 'lt_02_01', code: 'LT-2', name: '未授权区域', category: '保全派驻', zone: '塔山农业实验平台' },
      { stageId: 'lt_02_02', code: 'LT-2', name: '临时通道', category: '保全派驻', zone: '塔山农业实验平台' },
    ]
    await renderPanel({ result: null, candidates, onSelectStage })

    const pick = buttons().find(button => button.textContent?.includes('未授权区域'))
    expect(pick).not.toBeUndefined()
    await click(pick!)

    expect(onSelectStage).toHaveBeenCalledWith(candidates[0])
  })

  it('labels the resolved stage that produced the current results', async () => {
    await renderPanel({
      activeStage: {
        stageId: 'lt_02_01',
        code: 'LT-2',
        name: '未授权区域',
        category: '保全派驻',
        zone: '塔山农业实验平台',
      },
    })

    expect(container.textContent).toContain('当前关卡')
    expect(container.textContent).toContain('未授权区域')
  })

  it('forwards the search term from the input', async () => {
    const onSearch = vi.fn()
    await renderPanel({ result: null, onSearch })

    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-stage-search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'CE-6')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttons().find(button => button.textContent?.trim() === '搜索')!)

    expect(onSearch).toHaveBeenCalledWith('CE-6')
  })
})
