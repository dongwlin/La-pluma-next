import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const iosThemeStyles = readFileSync(new URL('./ios-theme.css', import.meta.url), 'utf8')

// 模态框通过 createPortal 渲染到 document.body，位于 .la-pluma-app 之外；加上应用根
// 作用域会让材质与遮罩规则静默失效，而 jsdom 无法求值级联，只能在源码层守住。
const stylesWithoutComments = iosThemeStyles.replace(/\/\*[\s\S]*?\*\//g, '')
const rulesWithoutIndent = stylesWithoutComments.replace(/^[ \t]+/gm, '')

describe('ios theme modal styles', () => {
  it('keeps the modal dialog material selector outside the app scope', () => {
    expect(stylesWithoutComments).toContain('.app-modal-layer .surface-panel')
    expect(stylesWithoutComments).not.toContain('.la-pluma-app .app-modal-layer')
  })

  it('keeps the modal backdrop selector outside the app scope', () => {
    expect(stylesWithoutComments).not.toContain('.la-pluma-app .app-modal-backdrop')
    expect(rulesWithoutIndent).toMatch(/^\.app-modal-backdrop\s*\{/m)
  })
})
