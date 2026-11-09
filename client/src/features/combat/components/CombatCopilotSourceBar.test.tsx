// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import { createPanelStateStore, type PanelStateStore } from '../model/panelState'
import type {
  CombatCopilotFileImportProjection,
  CombatCopilotSearchProjection,
} from './combatPanelTypes'
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

const setSelectValue = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const selectFile = async (input: HTMLInputElement, selected: File) => {
  Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const search = (overrides: Partial<CombatCopilotSearchProjection> = {}): CombatCopilotSearchProjection => ({
  stageStore: createPanelStateStore(''),
  selectionStore: createPanelStateStore(''),
  result: null,
  searching: false,
  addingUri: null,
  onSearch: () => {},
  onCancel: () => {},
  onSelectUri: () => {},
  onAddToQueue: () => {},
  ...overrides,
})

interface SourceBarProps {
  input: string
  isLoading: boolean
  hasPreview: boolean
  isAddingToQueue?: boolean
  previewModeStore: PanelStateStore<CopilotPreviewMode>
  search: CombatCopilotSearchProjection
  fileImport?: CombatCopilotFileImportProjection
  onInputChange: (value: string) => void
  onPreview: () => void
  onAddToQueue?: () => void
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

  it('reports the active recognition mode inside the URI field and cancels the preview when it changes', async () => {
    const onCancelPreview = vi.fn()
    const previewModeStore = createPanelStateStore<CopilotPreviewMode>('auto')
    await renderBar({ previewModeStore, onCancelPreview })

    const uri = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    const mode = container.querySelector<HTMLSelectElement>('select[name="maa-copilot-preview-mode"]')
    expect(uri).not.toBeNull()
    expect(mode).not.toBeNull()
    expect(mode!.parentElement).toBe(uri!.parentElement)
    expect(mode!.getAttribute('id')).toBe('combat-copilot-preview-mode')
    expect(container.querySelector('label[for="combat-copilot-preview-mode"]')?.textContent)
      .toBe('识别方式')
    expect(Array.from(mode!.options).map(option => option.textContent?.trim()))
      .toEqual(['自动', '单个作业', '作业集'])
    expect(mode!.value).toBe('auto')

    await setSelectValue(mode!, 'set')

    expect(onCancelPreview).toHaveBeenCalledOnce()
    expect(previewModeStore.get()).toBe('set')
    expect(mode!.value).toBe('set')
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

  it('adds the typed URI to the queue without replacing the preview action', async () => {
    const onPreview = vi.fn()
    const onAddToQueue = vi.fn()
    await renderBar({ input: 'prts://1234', onPreview, onAddToQueue })

    const add = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '加入队列')
    expect(add).not.toBeUndefined()
    expect(add?.disabled).toBe(false)

    await click(add!)

    expect(onAddToQueue).toHaveBeenCalledOnce()
    expect(onPreview).not.toHaveBeenCalled()
    expect(container.textContent).toContain('预览')
  })

  it('disables the queue action for an empty input or while adding', async () => {
    const onAddToQueue = vi.fn()
    await renderBar({ input: '', onAddToQueue })

    const emptyAdd = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '加入队列')
    expect(emptyAdd?.disabled).toBe(true)

    await renderBar({ input: 'prts://1234', isAddingToQueue: true, onAddToQueue })
    const adding = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '加入中')
    expect(adding?.disabled).toBe(true)
    expect(adding?.getAttribute('aria-busy')).toBe('true')
  })

  it('offers a labelled JSON file picker next to the import button', async () => {
    await renderBar({ fileImport: { isImporting: false, onImport: () => {} } })

    const input = container.querySelector<HTMLInputElement>('input[type="file"][name="maa-copilot-file"]')
    expect(input).not.toBeNull()
    expect(input?.accept).toContain('.json')
    expect(container.querySelector('label[for="combat-copilot-file"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button')).map(button => button.textContent?.trim()))
      .toContain('导入文件')
  })

  it('imports the chosen file and resets the file input', async () => {
    const onImport = vi.fn()
    await renderBar({ fileImport: { isImporting: false, onImport } })

    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-file"]')!
    const chosen = new File(['{}'], 'job.json', { type: 'application/json' })
    const resetValue = vi.fn()
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: resetValue })

    await selectFile(input, chosen)

    expect(onImport).toHaveBeenCalledOnce()
    expect(onImport).toHaveBeenCalledWith(chosen)
    expect(resetValue).toHaveBeenCalledWith('')
  })

  it('disables the import button and reports progress while a file is importing', async () => {
    await renderBar({ fileImport: { isImporting: true, onImport: () => {} } })

    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(candidate => candidate.textContent?.includes('导入中'))
    expect(button).not.toBeUndefined()
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-busy')).toBe('true')
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(container.textContent).not.toContain('导入文件')
  })
})
