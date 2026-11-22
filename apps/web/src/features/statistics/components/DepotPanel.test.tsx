// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateItemIconCache } from '@/features/game-data'
import { createQueryClient } from '@/shared/query'
import DepotPanel from './DepotPanel'
import type { StatisticsCommands } from '../hooks/useStatisticsCommands'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getDepotData: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const MotionDiv = React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children as ReactNode),
  )

  return { motion: { div: MotionDiv }, useReducedMotion: () => true }
})

vi.mock('@/features/game-data/api', () => ({
  getAllOperators: vi.fn(),
  getDepotData: mocks.getDepotData,
  getOperBoxData: vi.fn(),
  getItemIconUrl: (key: string | number) => `/items/${key}.png`,
}))

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const command = (overrides: Partial<StatisticsCommands> = {}): StatisticsCommands => ({
  isRunning: false,
  activeTask: null,
  activeKind: null,
  actionLabel: () => '立即执行',
  startRecognition: vi.fn(),
  fetchMaterials: vi.fn(),
  ...overrides,
})

const depotFixture = {
  itemCount: 2,
  items: [
    { id: '30012', name: '固源岩', count: 12, iconId: 'rock', classifyType: 'MATERIAL' },
    { id: '30013', name: '装置', count: 9, iconId: 'device', classifyType: 'MATERIAL' },
  ],
  timestamp: '2026-07-20T08:00:00.000Z',
}

const render = async (panelCommand: StatisticsCommands = command()) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DepotPanel isActive command={panelCommand} />
      </QueryClientProvider>,
    )
  })
  await flush()
}

describe('DepotPanel view states', () => {
  beforeEach(() => {
    mocks.getDepotData.mockReset()
    mocks.getDepotData.mockResolvedValue({ success: true, data: null })
    onlineManager.setOnline(true)
    client = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    onlineManager.setOnline(true)
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  })

  it('shows the query empty state while an unrelated command is still running', async () => {
    await render(command({ isRunning: true, activeKind: 'materials' }))

    expect(container.textContent).toContain('还没有仓库识别结果')
    expect(container.querySelector('[role="status"]')).toBeNull()

    const icon = container.querySelector('.app-empty-state-icon')
    expect(icon?.querySelector('svg')).not.toBeNull()
    expect(icon?.querySelector('.icon-well')).toBeNull()
  })

  it('drives the loading surface from the query alone', async () => {
    mocks.getDepotData.mockReset()
    mocks.getDepotData.mockReturnValue(new Promise(() => {}))

    await render(command({ isRunning: true, activeTask: 'depot', activeKind: 'depot' }))

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('正在识别仓库数据')
    expect(status?.parentElement?.hasAttribute('aria-live')).toBe(false)
  })

  it('shows the empty state once the query settles on null even when the command is active', async () => {
    await render(command({ isRunning: true, activeTask: 'depot', activeKind: 'depot' }))

    expect(container.textContent).toContain('还没有仓库识别结果')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('renders the card as a labelled region with a header title and no icon or subtitle', async () => {
    mocks.getDepotData.mockResolvedValue({ success: true, data: depotFixture })

    await render()

    const region = container.querySelector('[role="region"]')
    expect(region?.getAttribute('aria-labelledby')).toBe('depot-panel-title')

    const title = container.querySelector('#depot-panel-title')
    expect(title?.textContent).toBe('仓库识别')
    expect(title?.getAttribute('role')).toBe('heading')
    expect(title?.getAttribute('aria-level')).toBe('2')
    expect(container.textContent).not.toContain('汇总物品库存、材料分类与数量')
    expect(region?.querySelector('.icon-well')).toBeNull()
  })

  it('merges the top item and latest recognition time into one two-column KPI', async () => {
    mocks.getDepotData.mockResolvedValue({ success: true, data: depotFixture })

    await render()

    const group = container.querySelector('[role="group"]')
    expect(group?.getAttribute('aria-label')).toBe('仓库数据概览')

    const cells = Array.from(container.querySelectorAll<HTMLElement>('.data-statistics-kpi'))
    expect(cells).toHaveLength(5)

    const merged = cells[cells.length - 1]
    expect(merged?.classList.contains('col-span-2')).toBe(true)
    expect(merged?.textContent).toContain('库存最多')
    expect(merged?.textContent).toContain('固源岩')
    expect(merged?.textContent).toContain('最近识别')
    expect(merged?.textContent).toContain(new Date(depotFixture.timestamp).toLocaleString('zh-CN'))
  })

  it('keeps the merged KPI filled when the snapshot carries no timestamp', async () => {
    mocks.getDepotData.mockResolvedValue({
      success: true,
      data: { ...depotFixture, timestamp: undefined },
    })

    await render()

    const cells = Array.from(container.querySelectorAll<HTMLElement>('.data-statistics-kpi'))
    expect(cells).toHaveLength(5)
    expect(cells[cells.length - 1]?.textContent).toContain('最近识别-')
  })

  it('renders read-only item and category chips as badges without hover affordance', async () => {
    mocks.getDepotData.mockResolvedValue({ success: true, data: depotFixture })

    await render()

    expect(container.querySelector('.control-surface')).toBeNull()

    const chips = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="badge"]'))
      .map(badge => badge.textContent)

    expect(chips).toContain('材料·2 种/21 件')
    expect(chips).toContain('材料')
    expect(chips).toContain('×12')
    expect(chips).toContain('×9')
  })

  it('retries a failed depot icon after the icon cache version advances', async () => {
    mocks.getDepotData.mockResolvedValue({ success: true, data: depotFixture })

    await render()

    const failImage = async () => {
      await act(async () => {
        container.querySelector<HTMLImageElement>('img[alt="固源岩"]')
          ?.dispatchEvent(new Event('error', { bubbles: true }))
      })
    }

    await failImage()
    expect(container.querySelector('img[alt="固源岩"]')).toBeNull()
    expect(container.querySelector('[role="img"][aria-label="固源岩图标不可用"]')).not.toBeNull()

    await act(async () => {
      invalidateItemIconCache()
    })
    expect(container.querySelector('img[alt="固源岩"]')).not.toBeNull()
    expect(container.querySelector('[role="img"][aria-label="固源岩图标不可用"]')).toBeNull()

    await failImage()
    expect(container.querySelector('img[alt="固源岩"]')).toBeNull()
    expect(container.querySelector('[role="img"][aria-label="固源岩图标不可用"]')).not.toBeNull()
  })
})
