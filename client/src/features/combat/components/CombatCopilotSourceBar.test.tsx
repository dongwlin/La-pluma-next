// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import { createPanelStateStore, type PanelStateStore } from '../model/panelState'
import type { CombatCopilotSearchProjection } from './combatPanelTypes'
import CombatCopilotSourceBar from './CombatCopilotSourceBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const search = (overrides: Partial<CombatCopilotSearchProjection> = {}): CombatCopilotSearchProjection => ({
  stageStore: createPanelStateStore(''),
  selectionStore: createPanelStateStore(''),
  result: null,
  searching: false,
  onSearch: () => {},
  onCancel: () => {},
  onSelectUri: () => {},
  ...overrides,
})

interface SourceBarProps {
  input: string
  isLoading: boolean
  hasPreview: boolean
  previewModeStore: PanelStateStore<CopilotPreviewMode>
  search: CombatCopilotSearchProjection
  onInputChange: (value: string) => void
  onPreview: () => void
  onCancelPreview: () => void
  onClear: () => void
}

function baseProps(overrides: Partial<SourceBarProps> = {}): SourceBarProps {
  return {
    input: '',
    isLoading: false,
    hasPreview: false,
    previewModeStore: createPanelStateStore<CopilotPreviewMode>('auto'),
    search: search(),
    onInputChange: () => {},
    onPreview: () => {},
    onCancelPreview: () => {},
    onClear: () => {},
    ...overrides,
  }
}

describe('CombatCopilotSourceBar', () => {
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

  const renderBar = async (props: Partial<SourceBarProps> = {}) => {
    await act(async () => {
      root.render(<CombatCopilotSourceBar {...baseProps(props)} />)
    })
  }

  it('keeps both named source inputs and their labels mounted', async () => {
    await renderBar({ input: 'prts://1234' })

    const uri = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    const stage = container.querySelector<HTMLInputElement>('input[name="maa-copilot-stage-search"]')
    expect(uri?.value).toBe('prts://1234')
    expect(stage).not.toBeNull()
    expect(container.querySelector('label[for="combat-copilot-uri"]')).not.toBeNull()
    expect(container.querySelector('label[for="combat-stage-search"]')).not.toBeNull()
  })

  it('previews the typed URI and only offers clear when a preview exists', async () => {
    const onPreview = vi.fn()
    const onClear = vi.fn()
    await renderBar({ input: 'prts://1234', onPreview, onClear })

    expect(container.textContent).not.toContain('清除预览')
    await click(Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '预览')!)

    expect(onPreview).toHaveBeenCalledOnce()

    await renderBar({ input: 'prts://1234', hasPreview: true, onClear })
    const clear = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '清除预览')
    expect(clear).not.toBeUndefined()
    await click(clear!)

    expect(onClear).toHaveBeenCalledOnce()
  })

  it('reports the active recognition mode and cancels the preview when it changes', async () => {
    const onCancelPreview = vi.fn()
    const previewModeStore = createPanelStateStore<CopilotPreviewMode>('auto')
    await renderBar({ previewModeStore, onCancelPreview })

    const group = container.querySelector<HTMLElement>('[role="group"][aria-label="识别方式"]')
    expect(group).not.toBeNull()
    const buttons = Array.from(group!.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['自动', '单个作业', '作业集'])
    expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])

    await click(buttons[2]!)

    expect(onCancelPreview).toHaveBeenCalledOnce()
    expect(previewModeStore.get()).toBe('set')
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
  })

  it('forwards the search term and the clicked search result', async () => {
    const onSearch = vi.fn()
    const onSelectUri = vi.fn()
    const projection = search({
      selectionStore: createPanelStateStore('prts://1'),
      result: {
        stage: '1-7',
        copilots: [
          { id: '1', uri: 'prts://1', title: '搜索结果作业', views: 0, hotScore: 0 },
        ],
      },
      onSearch,
      onSelectUri,
    })
    await renderBar({ search: projection })

    const stageInput = container.querySelector<HTMLInputElement>('input[name="maa-copilot-stage-search"]')!
    await setInputValue(stageInput, '1-7')
    await click(Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '搜索')!)

    expect(onSearch).toHaveBeenCalledWith('1-7')

    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('搜索结果作业'))!)

    expect(onSelectUri).toHaveBeenCalledWith('prts://1')
    expect(container.textContent).toContain('已选中')
  })
})
