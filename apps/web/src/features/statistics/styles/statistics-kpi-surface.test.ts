import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(
  fileURLToPath(new URL('./statistics.css', import.meta.url)),
  'utf8',
)

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .flatMap(match => (match[1] ? [match[1]] : []))
  return blocks.join('\n')
}

describe('statistics KPI surface styles', () => {
  it('keeps the KPI cells opaque so the group seam reaches text contrast', () => {
    const cell = ruleBody(CSS, '.data-statistics-kpi')

    expect(cell).toContain('background: var(--card)')
    expect(cell).not.toContain('color-mix')
  })

  it('draws the KPI group with real hairlines instead of a gap-filled backdrop', () => {
    const grid = ruleBody(CSS, '.data-statistics-kpi-grid')

    expect(grid).toContain('border: 1px solid var(--border)')
    expect(grid).toContain('overflow: hidden')
    expect(grid).not.toContain('gap:')
    expect(grid).not.toContain('padding:')
    expect(grid).not.toContain('background: var(--border)')
  })

  it('keeps the hairline between the merged item name and the recognition time', () => {
    const split = ruleBody(CSS, '.data-statistics-kpi-split > :not(:last-child)')

    expect(split).toContain('border-right: 1px solid var(--border)')
    expect(ruleBody(CSS, '.data-statistics-kpi-split > *')).toContain('padding: 0.75rem')
  })

  it('separates the wrapping depot KPI by column and row at both breakpoints', () => {
    expect(ruleBody(CSS, '.data-statistics-kpi-grid-depot > :nth-child(2n)'))
      .toContain('border-right: 0')
    expect(ruleBody(CSS, '.data-statistics-kpi-grid-depot > :nth-child(n + 3)'))
      .toContain('border-top: 1px solid var(--border)')
    expect(ruleBody(CSS, '.data-statistics-kpi-grid-depot > :nth-child(n + 4)'))
      .toContain('border-top: 1px solid var(--border)')
  })
})
