// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LogConsole from './LogConsole'
import type { LogEntry } from '../types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ConsoleProps = ComponentProps<typeof LogConsole>

const entry = (message: string, time = '10:00:00'): LogEntry => ({ time, level: 'INFO', message })

const initialLogs = [entry('第一行'), entry('第二行'), entry('第三行')]

const baseProps = (logs: readonly LogEntry[]): ConsoleProps => ({
  viewingHistory: false,
  selectedFile: null,
  loading: false,
  error: null,
  logs,
  view: {
    readable: logs,
    filtered: logs,
    visible: logs.map(log => ({ ...log, count: 1 })),
  },
  autoScroll: true,
  paused: false,
  onRetry: () => {},
  onBackToRealtime: () => {},
})

let container: HTMLDivElement
let root: Root

const renderConsole = async (logs: readonly LogEntry[], overrides: Partial<ConsoleProps> = {}) => {
  await act(async () => root.render(<LogConsole {...baseProps(logs)} {...overrides} />))
  await act(async () => {
    await Promise.resolve()
  })
}

const getLogNode = () => {
  const node = container.querySelector<HTMLElement>('[role="log"]')
  if (!node) throw new Error('log container is missing')
  return node
}

/** jsdom 没有布局：以实例属性伪装滚动盒尺寸，scrollTop 可写可读。 */
const defineScrollBox = (node: HTMLElement, scrollHeight: number, clientHeight: number) => {
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(node, 'scrollTop', { configurable: true, writable: true, value: 0 })
}

const scrollNode = async (node: HTMLElement) => {
  await act(async () => node.dispatchEvent(new Event('scroll')))
}

const findFollowIndicator = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find(button => button.textContent?.includes('条新日志') || button.textContent?.includes('回到底部'))

describe('LogConsole scroll following', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('follows content changes but keeps the scroll position when only the reference changes', async () => {
    await renderConsole(initialLogs)
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    const grownLogs = [...initialLogs, entry('第四行')]
    await renderConsole(grownLogs)
    expect(node.scrollTop).toBe(1000)

    // 引用变化但内容不变：不再强制滚回底部
    node.scrollTop = 500
    await renderConsole(grownLogs.map(log => ({ ...log })))
    expect(node.scrollTop).toBe(500)

    // 内容再次变化：恢复跟随
    await renderConsole([...grownLogs, entry('第五行')])
    expect(node.scrollTop).toBe(1000)
  })

  it('pauses when the user scrolls away, counts unread rows and resumes at the bottom', async () => {
    await renderConsole(initialLogs)
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    // 用户上滑离开底部：进入智能暂停，指示可见且未读为 0
    node.scrollTop = 120
    await scrollNode(node)
    expect(findFollowIndicator()?.textContent).toBe('回到底部')

    // 暂停期间内容变化：不抢滚动位置，新增行累计为未读数
    await renderConsole([...initialLogs, entry('新增一'), entry('新增二')])
    expect(node.scrollTop).toBe(120)
    expect(findFollowIndicator()?.textContent).toBe('2 条新日志')

    // 暂停中继续上滑不重置计数
    node.scrollTop = 60
    await scrollNode(node)
    expect(findFollowIndicator()?.textContent).toBe('2 条新日志')

    // 回到底部：恢复跟随并清零
    node.scrollTop = 1000
    await scrollNode(node)
    expect(findFollowIndicator()).toBeUndefined()

    // 恢复后内容变化继续跟随
    await renderConsole([...initialLogs, entry('新增一'), entry('新增二'), entry('新增三')])
    expect(node.scrollTop).toBe(1000)
    expect(findFollowIndicator()).toBeUndefined()
  })

  it('resumes following and clears the count from the indicator click', async () => {
    await renderConsole(initialLogs)
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 120
    await scrollNode(node)
    await renderConsole([...initialLogs, entry('新增一')])

    const indicator = findFollowIndicator()
    expect(indicator?.textContent).toBe('1 条新日志')
    await act(async () => indicator?.click())
    await act(async () => {
      await Promise.resolve()
    })

    expect(findFollowIndicator()).toBeUndefined()
    expect(node.scrollTop).toBe(1000)

    await renderConsole([...initialLogs, entry('新增一'), entry('新增二')])
    expect(node.scrollTop).toBe(1000)
  })

  it('never follows or shows the indicator while the manual switch is off', async () => {
    await renderConsole(initialLogs, { autoScroll: false })
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 200
    await scrollNode(node)
    expect(findFollowIndicator()).toBeUndefined()

    await renderConsole([...initialLogs, entry('新增一')], { autoScroll: false })
    expect(node.scrollTop).toBe(200)
    expect(findFollowIndicator()).toBeUndefined()
  })

  it('clears the smart pause when the manual switch toggles and follows again after it turns back on', async () => {
    await renderConsole(initialLogs)
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 120
    await scrollNode(node)
    expect(findFollowIndicator()).not.toBeUndefined()

    await renderConsole(initialLogs.map(log => ({ ...log })), { autoScroll: false })
    expect(findFollowIndicator()).toBeUndefined()
    expect(node.scrollTop).toBe(120)

    await renderConsole(initialLogs.map(log => ({ ...log })), { autoScroll: true })
    expect(node.scrollTop).toBe(1000)
    expect(findFollowIndicator()).toBeUndefined()
  })

  it('does not follow in history view', async () => {
    const historyLogs = [entry('历史一'), entry('历史二')]
    await renderConsole(historyLogs, { viewingHistory: true, autoScroll: true })
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 100
    await scrollNode(node)
    expect(findFollowIndicator()).toBeUndefined()

    await renderConsole([...historyLogs, entry('历史三')], { viewingHistory: true, autoScroll: true })
    expect(node.scrollTop).toBe(100)
  })
})
