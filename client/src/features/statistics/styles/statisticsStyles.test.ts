import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const statisticsStyles = readFileSync(new URL('./statistics.css', import.meta.url), 'utf8')

// 筛选菜单由 createPortal 渲染到 document.body，不在 .la-pluma-app 内；加上应用根
// 作用域会让材质规则静默失效，而 jsdom 无法求值级联，只能在源码层守住。
const selectorsWithoutComments = statisticsStyles.replace(/\/\*[\s\S]*?\*\//g, '')
const menuSelectors = [...selectorsWithoutComments.matchAll(/[^{}]*\.data-statistics-menu-surface[^{}]*\{/g)]
  .map(([rule]) => rule.slice(0, -1).trim())

describe('statistics styles', () => {
  it('keeps the filter menu material selector outside the app scope', () => {
    expect(selectorsWithoutComments).toContain('.surface-panel.data-statistics-menu-surface')
    expect(menuSelectors.length).toBeGreaterThan(0)

    for (const selector of menuSelectors) {
      expect(selector).not.toContain('.la-pluma-app')
    }
  })
})
