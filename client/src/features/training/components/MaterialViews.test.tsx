// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaterialNode } from '../types'
import { MaterialTable, MaterialTree } from './MaterialViews'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/features/game-data', () => ({
  getItemIconUrl: (id: string | number) => `/items/${id}.png`,
  useItemIconCacheVersion: () => 0,
}))

const material = (id: string, name: string, stillNeeded: number): MaterialNode => ({
  id,
  name,
  iconId: id,
  count: stillNeeded + 2,
  have: 2,
  needed: stillNeeded + 2,
  stillNeeded,
})

let container: HTMLDivElement
let root: Root

describe('training material views', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps the gap table semantics and reports collected rows', async () => {
    await act(async () => root.render(<MaterialTable materials={[
      material('30012', '固源岩', 3),
      material('4001', '龙门币', 0),
    ]} />))

    const table = container.querySelector('[role="table"]')
    expect(table?.getAttribute('aria-label')).toBe('材料筹备明细')
    expect(Array.from(container.querySelectorAll('[role="columnheader"]')).map(cell => cell.textContent))
      .toEqual(['材料', '拥有', '需要', '缺口'])
    expect(Array.from(container.querySelectorAll('[role="cell"]')).map(cell => cell.textContent))
      .toEqual(['固源岩', '2', '5', '3', '龙门币', '2', '2', '已齐'])
  })

  it('renders nested synthesis levels as a hierarchy', async () => {
    const parent = {
      ...material('30013', '聚酸酯', 1),
      children: [material('30012', '固源岩', 2)],
    }
    await act(async () => root.render(<MaterialTree nodes={[parent]} />))

    const topLevel = container.querySelectorAll(':scope > ul.training-material-tree > li')
    expect(topLevel).toHaveLength(1)
    expect(topLevel[0]?.textContent).toContain('聚酸酯')
    expect(topLevel[0]?.textContent).toContain('缺 1')
    expect(topLevel[0]?.querySelectorAll('.training-material-tree > li')).toHaveLength(1)
    expect(topLevel[0]?.textContent).toContain('固源岩')
  })
})
