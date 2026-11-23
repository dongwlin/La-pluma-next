// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameDataKeys, invalidateItemIconCache } from '@/features/game-data'
import { createQueryClient } from '@/shared/query'
import OperatorPanel from './OperatorPanel'
import type { StatisticsCommands } from '../hooks/useStatisticsCommands'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getAllOperators: vi.fn(),
  getOperBoxData: vi.fn(),
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
  getAllOperators: mocks.getAllOperators,
  getDepotData: vi.fn(),
  getOperBoxData: mocks.getOperBoxData,
  getItemIconUrl: (key: string | number) => `/items/${key}.png`,
  getOperatorAvatarUrl: (operatorId: string, variant: string = 'base') =>
    `/avatars/${operatorId}${variant === 'base' ? '' : `_${variant}`}.png`,
}))

const operator = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name,
  rarity: 4,
  profession: 'SNIPER',
  level: 0,
  elite: 0,
  potential: 1,
  ...overrides,
})

const catalogPayload = (operators: unknown[]) => ({ success: true, data: operators })
const operBoxPayload = (data: unknown[], overrides: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    operCount: data.length,
    data,
    timestamp: '2026-07-20T08:00:00.000Z',
    ...overrides,
  },
})

const command = (overrides: Partial<StatisticsCommands> = {}): StatisticsCommands => ({
  isRunning: false,
  activeTask: null,
  activeKind: null,
  actionLabel: () => '识别',
  startRecognition: vi.fn(),
  fetchMaterials: vi.fn(),
  ...overrides,
})

let client: ReturnType<typeof createQueryClient>
let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const render = async (panelCommand: StatisticsCommands = command()) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <OperatorPanel isActive command={panelCommand} />
      </QueryClientProvider>,
    )
  })
  await flush()
}

const kpiGroup = () => container.querySelector<HTMLElement>('[role="group"][aria-label="干员数据概览"]')

const kpiValue = (label: string) => {
  const group = kpiGroup()
  const term = Array.from(group?.querySelectorAll('dt') ?? [])
    .find(item => item.textContent === label)
  return term?.nextElementSibling?.textContent
}

const operatorItems = () => Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))

const selectOption = async (triggerLabel: string, optionLabel: string) => {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent === triggerLabel)
  await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await flush()
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    .find(item => item.textContent === optionLabel)
  await act(async () => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await flush()
}

describe('OperatorPanel coverage and query states', () => {
  beforeEach(() => {
    mocks.getAllOperators.mockReset()
    mocks.getOperBoxData.mockReset()
    mocks.getAllOperators.mockResolvedValue(catalogPayload([]))
    mocks.getOperBoxData.mockResolvedValue({ success: true, data: null })
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

  it('shows an unknown coverage instead of inventing a denominator from the snapshot', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload(
      [operator('char_alpha', '阿尔法', { level: 80 })],
      {
        operTotal: 1,
        allOpers: [{ id: 'char_alpha', name: '阿尔法', rarity: 4, owned: true }],
        recognition: { status: 'partial', total: 1, owned: 1 },
      },
    ))

    await render()

    expect(container.textContent).toContain('阿尔法')
    expect(kpiValue('档案覆盖')).toBe('—')
  })

  it('clamps coverage at 100% when the owned count exceeds the catalogue', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
      operator('char_beta', '贝塔', { rarity: 5, level: 50 }),
    ]))

    await render()

    expect(kpiValue('档案覆盖')).toBe('100%')
  })

  it('rounds trusted coverage from the remote catalogue only', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法'),
      operator('char_beta', '贝塔'),
      operator('char_gamma', '伽马'),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { level: 80 }),
      operator('char_beta', '贝塔', { level: 50 }),
    ]))

    await render()

    expect(kpiValue('干员资料')).toBe('3')
    expect(kpiValue('档案覆盖')).toBe('67%')
  })

  it('excludes snapshot fallback entries from the coverage denominator', async () => {
    mocks.getAllOperators.mockResolvedValue({ success: false, message: '目录服务不可用' })
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload(
      [operator('char_alpha', '阿尔法', { level: 80 })],
      {
        allOpers: [
          { id: 'char_alpha', name: '阿尔法', rarity: 6, owned: true },
          { id: 'char_beta', name: '贝塔', rarity: 5, owned: false },
        ],
      },
    ))

    await render()

    expect(container.textContent).toContain('贝塔')
    expect(kpiValue('干员资料')).toBe('—')
    expect(kpiValue('档案覆盖')).toBe('—')
  })

  it('shows the empty state while an unrelated command keeps running', async () => {
    await render(command({ isRunning: true, activeKind: 'materials' }))

    expect(container.textContent).toContain('还没有干员识别结果')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('drives the loading surface from the query alone and keeps the running button', async () => {
    mocks.getAllOperators.mockReturnValue(new Promise(() => {}))
    mocks.getOperBoxData.mockReturnValue(new Promise(() => {}))

    await render(command({ isRunning: true, activeTask: 'operbox', activeKind: 'operbox' }))

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('正在识别干员数据')
    expect(status?.parentElement?.hasAttribute('aria-live')).toBe(false)
    expect(container.textContent).toContain('正在执行')
  })

  it('shows the empty state instead of a blank panel while materials refresh', async () => {
    await render(command({ isRunning: true, activeKind: 'materials' }))

    expect(container.textContent).toContain('还没有干员识别结果')
  })

  it('restores a failed avatar once the icon cache version advances', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    await render()

    const failAvatar = async () => {
      await act(async () => {
        container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')
          ?.dispatchEvent(new Event('error', { bubbles: true }))
      })
      await flush()
    }

    await failAvatar()
    await failAvatar()
    await failAvatar()

    expect(container.querySelector('img[alt="阿尔法"]')).toBeNull()
    expect(container.querySelector('[role="img"][aria-label="阿尔法头像不可用"]')).not.toBeNull()

    await act(async () => {
      invalidateItemIconCache()
    })
    await flush()

    expect(container.querySelector('img[alt="阿尔法"]')).not.toBeNull()
    expect(container.querySelector('[role="img"][aria-label="阿尔法头像不可用"]')).toBeNull()
  })

  it('resets avatar variants and load state when the icon cache version advances', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    await render()

    const avatarSrc = () => container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')?.getAttribute('src')
    const busyFrame = () => container.querySelector('[role="listitem"] [aria-busy="true"]')

    expect(avatarSrc()).toBe('/avatars/char_alpha.png')
    expect(busyFrame()).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')
        ?.dispatchEvent(new Event('load'))
    })
    await flush()
    expect(busyFrame()).toBeNull()

    await act(async () => {
      container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')
        ?.dispatchEvent(new Event('error', { bubbles: true }))
    })
    await flush()
    expect(avatarSrc()).toBe('/avatars/char_alpha_2.png')

    await act(async () => {
      invalidateItemIconCache()
    })
    await flush()

    expect(avatarSrc()).toBe('/avatars/char_alpha.png')
    expect(busyFrame()).not.toBeNull()
  })

  it('falls back through the numbered avatar variants before failing', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    await render()

    const avatarSrc = () => container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')?.getAttribute('src')
    const failAvatar = async () => {
      await act(async () => {
        container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')
          ?.dispatchEvent(new Event('error', { bubbles: true }))
      })
      await flush()
    }

    expect(avatarSrc()).toBe('/avatars/char_alpha.png')

    await failAvatar()
    expect(avatarSrc()).toBe('/avatars/char_alpha_2.png')

    await failAvatar()
    expect(avatarSrc()).toBe('/avatars/char_alpha_1.png')
  })

  it('renders the card as a labelled region with a header title and no icon or subtitle', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    await render()

    const region = container.querySelector('[role="region"]')
    expect(region?.getAttribute('aria-labelledby')).toBe('operator-panel-title')

    const title = container.querySelector('#operator-panel-title')
    expect(title?.textContent).toBe('干员识别')
    expect(title?.getAttribute('role')).toBe('heading')
    expect(title?.getAttribute('aria-level')).toBe('2')
    expect(container.textContent).not.toContain('读取档案、等级、精英化与潜能数据')
    const decorativeIcons = Array.from(title?.parentElement?.querySelectorAll('svg') ?? [])
      .filter(icon => icon.closest('button') === null)
    expect(decorativeIcons).toEqual([])
  })

  it('groups the KPI row and reports read-only chips without interactive affordance', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
      operator('char_beta', '贝塔', { rarity: 5 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload(
      [operator('char_alpha', '阿尔法', { rarity: 6, level: 80, elite: 2, potential: 3 })],
      {
        allOpers: [
          { id: 'char_alpha', name: '阿尔法', rarity: 6, owned: true },
          { id: 'char_beta', name: '贝塔', rarity: 5, owned: false },
        ],
        recognition: { status: 'complete', total: 2, owned: 1 },
      },
    ))

    await render()

    const group = kpiGroup()
    expect(group).not.toBeNull()
    expect(Array.from(group!.querySelectorAll('dt')).map(item => item.textContent))
      .toEqual(['已识别', '干员资料', '当前显示', '档案覆盖'])

    const items = operatorItems()
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.querySelector('button, a, [role="button"]')).toBeNull()
    }
    expect(items[0]?.textContent).toContain('精2')
    expect(items[0]?.textContent).toContain('Lv.80')
    expect(items[0]?.textContent).not.toContain('未拥有')
    expect(items[1]?.textContent).toContain('未拥有')
  })

  it('marks the avatar frame as busy until the image loads', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6 }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
    ]))

    await render()

    expect(container.querySelector('[role="listitem"] [aria-busy="true"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLImageElement>('img[alt="阿尔法"]')
        ?.dispatchEvent(new Event('load'))
    })
    await flush()

    expect(container.querySelector('[role="listitem"] [aria-busy="true"]')).toBeNull()
  })

  it('renders the canonical action label passed down by the command hook', async () => {
    const actionButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .map(button => button.textContent ?? '')
      .filter(label => label !== '获取材料数据')

    await render(command({ actionLabel: () => '识别' }))
    expect(actionButton()).toContain('识别')

    await act(async () => root.unmount())
    root = createRoot(container)
    await render(command({ actionLabel: () => '重新识别' }))
    expect(actionButton()).toContain('重新识别')

    await act(async () => root.unmount())
    root = createRoot(container)
    await render(command({ actionLabel: () => '继续解析' }))
    expect(actionButton()).toContain('继续解析')
  })

  it('renders a bare 24px lucide icon in the empty state', async () => {
    client.clear()

    await render()

    const title = Array.from(container.querySelectorAll('strong'))
      .find(item => item.textContent === '还没有干员识别结果')
    const icons = Array.from(title?.parentElement?.querySelectorAll('svg') ?? [])

    expect(icons).toHaveLength(1)
    expect(icons[0]?.getAttribute('width')).toBe('24')
    expect(icons[0]?.getAttribute('stroke-width')).toBe('1.7')
  })

  it('hides stale coverage once a refetch of the remote catalogue fails', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法'),
      operator('char_beta', '贝塔'),
      operator('char_gamma', '伽马'),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { level: 80 }),
      operator('char_beta', '贝塔', { level: 50 }),
    ]))

    await render()

    expect(kpiValue('干员资料')).toBe('3')
    expect(kpiValue('档案覆盖')).toBe('67%')

    mocks.getAllOperators.mockResolvedValue({ success: false, message: '目录服务不可用' })
    await act(async () => {
      await client.invalidateQueries({ queryKey: gameDataKeys.resource('catalog') })
    })
    await flush()

    expect(kpiValue('干员资料')).toBe('—')
    expect(kpiValue('档案覆盖')).toBe('—')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('干员数据读取失败')
    expect(container.textContent).toContain('阿尔法')
  })

  it('keeps elite filters on the unowned view of a snapshot catalogue', async () => {
    mocks.getAllOperators.mockResolvedValue({ success: false, message: '目录服务不可用' })
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload(
      [operator('char_alpha', '阿尔法', { profession: '', level: 80, elite: 2, potential: 3 })],
      {
        allOpers: [
          { id: 'char_alpha', name: '阿尔法', rarity: 6, owned: true },
          { id: 'char_beta', name: '贝塔', rarity: 5, owned: false },
        ],
        recognition: { status: 'complete', total: 2, owned: 1 },
      },
    ))

    await render()

    await selectOption('拥有状态', '未拥有')
    expect(operatorItems().map(item => item.textContent)).toEqual([expect.stringContaining('贝塔')])

    await selectOption('精英化', '精英0')
    expect(operatorItems().map(item => item.textContent)).toEqual([expect.stringContaining('贝塔')])
  })

  it('explains that the snapshot catalogue cannot filter by profession', async () => {
    mocks.getAllOperators.mockResolvedValue({ success: false, message: '目录服务不可用' })
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload(
      [operator('char_alpha', '阿尔法', { profession: '', level: 80, elite: 2, potential: 3 })],
      {
        allOpers: [
          { id: 'char_alpha', name: '阿尔法', rarity: 6, owned: true },
          { id: 'char_beta', name: '贝塔', rarity: 5, owned: false },
        ],
        recognition: { status: 'complete', total: 2, owned: 1 },
      },
    ))

    await render()

    expect(operatorItems()).toHaveLength(2)

    await selectOption('职业', '狙击')

    expect(operatorItems()).toEqual([])
    expect(kpiValue('当前显示')).toBe('0')
    expect(container.textContent).toContain('快照目录不含职业信息')
    expect(container.textContent).toContain('无法按职业筛选')
  })

  it('keeps profession filtering available for a trusted remote catalogue', async () => {
    mocks.getAllOperators.mockResolvedValue(catalogPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, profession: 'SNIPER' }),
      operator('char_beta', '贝塔', { rarity: 5, profession: 'MEDIC' }),
    ]))
    mocks.getOperBoxData.mockResolvedValue(operBoxPayload([
      operator('char_alpha', '阿尔法', { rarity: 6, level: 80 }),
      operator('char_beta', '贝塔', { rarity: 5, level: 50, profession: 'MEDIC' }),
    ]))

    await render()

    await selectOption('职业', '狙击')

    expect(operatorItems().map(item => item.textContent)).toEqual([expect.stringContaining('阿尔法')])
    expect(container.textContent).not.toContain('快照目录不含职业信息')
  })
})
