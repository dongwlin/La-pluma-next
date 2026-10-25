import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @keyframes 只被 animation 声明按名字引用，删掉声明不会报错、也不会让截图变化
// （视觉基线冻结动画），只有引用完整性检查能拦住。页面样式分散在各功能域，
// 而 stylelint 的 no-unknown-animations 只解析单文件，跨文件引用在这里统一核对。

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const KEYFRAMES_RE = /@keyframes\s+([A-Za-z_][\w-]*)/g
const ANIMATION_DECL_RE = /(?:^|[;{\s])animation(?:-name)?\s*:\s*([^;{}]+)/g

const NOT_A_NAME = new Set([
  'auto',
  'both',
  'ease',
  'ease-in',
  'ease-in-out',
  'ease-out',
  'forwards',
  'infinite',
  'inherit',
  'initial',
  'linear',
  'none',
  'normal',
  'paused',
  'reverse',
  'revert',
  'revert-layer',
  'run-in',
  'running',
  'step-end',
  'step-start',
  'unset',
])

const isTimingOrCount = (token: string) => /^-?[\d.]+m?s$/.test(token) || /^-?[\d.]+$/.test(token)

/** 只按顶层逗号分组，steps(8, end) 这类函数参数不能拆开。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** 从 animation/animation-name 的值里取出动画名（跳过时间、关键字与函数）。 */
export function animationNames(value: string): string[] {
  return splitTopLevel(value.replace(/!\s*important/gi, '')).flatMap(part => {
    const name = part.trim().split(/\s+/).find(token => (
      token !== ''
      && !NOT_A_NAME.has(token.toLowerCase())
      && !isTimingOrCount(token)
      && !/[()]/.test(token)
    ))
    return name ? [name] : []
  })
}

function collectCssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectCssFiles(path)
    return path.endsWith('.css') ? [path] : []
  })
}

describe('stylesheet animation references', () => {
  it('declares every animation referenced from any stylesheet', () => {
    const declared = new Set<string>()
    const references: Array<{ name: string; location: string }> = []

    for (const file of collectCssFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8')
      const location = relative(SOURCE_ROOT, file)

      for (const [, name] of source.matchAll(KEYFRAMES_RE)) {
        if (name) declared.add(name)
      }

      for (const match of source.matchAll(ANIMATION_DECL_RE)) {
        const line = source.slice(0, match.index ?? 0).split('\n').length
        for (const name of animationNames(match[1] ?? '')) {
          references.push({ name, location: `${location}:${line}` })
        }
      }
    }

    expect(references.length).toBeGreaterThan(0)
    expect(references.filter(({ name }) => !declared.has(name)).map(({ name, location }) => `${location} → ${name}`))
      .toEqual([])
  })
})
