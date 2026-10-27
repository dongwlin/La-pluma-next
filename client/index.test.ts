// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(resolve(cwd(), 'index.html'), 'utf8')
const sourceDocument = new DOMParser().parseFromString(indexSource, 'text/html')

describe('PWA document boot shell', () => {
  it('paints a static shell before the module entry can run', () => {
    const bootStyle = sourceDocument.querySelector('#la-pluma-boot-style')
    const bootShell = sourceDocument.querySelector('#root [role="status"]')
    const styleIndex = indexSource.indexOf('id="la-pluma-boot-style"')
    const moduleIndex = indexSource.indexOf('src="/src/main.tsx"')

    expect(bootStyle?.textContent).toMatch(/html,\s*body,\s*#root\s*{[^}]*background-color:/s)
    expect(styleIndex).toBeGreaterThan(0)
    expect(moduleIndex).toBeGreaterThan(styleIndex)
    expect(bootShell?.getAttribute('aria-busy')).toBe('true')
  })
})
