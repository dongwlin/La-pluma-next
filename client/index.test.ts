// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

// React 通过这个全局标记识别 act 环境；@types/react 未声明它。
const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true

const indexSource = readFileSync(resolve(cwd(), 'index.html'), 'utf8')
const sourceDocument = new DOMParser().parseFromString(indexSource, 'text/html')

describe('PWA document boot shell', () => {
  it('paints a static shell before the module entry can run', () => {
    const bootStyle = sourceDocument.querySelector('#la-pluma-boot-style')
    const root = sourceDocument.querySelector('#root')
    const bootShell = root?.firstElementChild
    const styleIndex = indexSource.indexOf('id="la-pluma-boot-style"')
    const moduleIndex = indexSource.indexOf('src="/src/main.tsx"')

    expect(bootStyle?.textContent).toMatch(/html,\s*body,\s*#root\s*{[^}]*background-color:/s)
    expect(styleIndex).toBeGreaterThan(0)
    expect(moduleIndex).toBeGreaterThan(styleIndex)
    expect(bootShell?.classList.contains('la-pluma-boot')).toBe(true)
    expect(bootShell?.getAttribute('aria-busy')).toBe('true')
  })

  it('is replaced by the first React commit', async () => {
    const sourceRoot = sourceDocument.querySelector('#root')
    document.body.innerHTML = sourceRoot?.outerHTML ?? '<div id="root"></div>'
    const rootElement = document.getElementById('root')
    if (!rootElement) throw new Error('index.html 缺少 #root 容器')
    expect(rootElement.querySelector('.la-pluma-boot')).toBeTruthy()

    const reactRoot = createRoot(rootElement)
    await act(async () => {
      reactRoot.render(createElement('main', { 'data-react-ready': 'true' }, '已恢复'))
    })

    expect(rootElement.querySelector('.la-pluma-boot')).toBeNull()
    expect(rootElement.querySelector('[data-react-ready="true"]')?.textContent).toBe('已恢复')

    await act(async () => reactRoot.unmount())
  })
})
