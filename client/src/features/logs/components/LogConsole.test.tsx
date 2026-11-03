// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LogConsole from './LogConsole'
import type { LogEntry } from '../types'
import { buildLogView } from '../model/logModel'

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
  view: buildLogView(logs, { events: 'all', level: 'all', search: '', collapseRepeats: true }),
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

/** 实时区域的播报开关：用户在回顾旧内容时应静音，避免新行打断朗读。 */
const liveMode = () => container.querySelector('[role="log"]')?.getAttribute('aria-live')

const findFollowIndicator = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find(button => button.textContent?.includes('有新日志') || button.textContent?.includes('回到底部'))

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
    expect(findFollowIndicator()?.textContent).toBe('有新日志')

    // 暂停中继续上滑不重置计数
    node.scrollTop = 60
    await scrollNode(node)
    expect(findFollowIndicator()?.textContent).toBe('有新日志')

    // 回到底部：恢复跟随并清零
    node.scrollTop = 1000
    await scrollNode(node)
    expect(findFollowIndicator()).toBeUndefined()

    // 恢复后内容变化继续跟随
    await renderConsole([...initialLogs, entry('新增一'), entry('新增二'), entry('新增三')])
    expect(node.scrollTop).toBe(1000)
    expect(findFollowIndicator()).toBeUndefined()
  })

  it('mutes the live region while following is paused and restores it at the bottom', async () => {
    await renderConsole(initialLogs)
    expect(liveMode()).toBe('polite')

    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    // 上滑离开底部：用户在看旧行，新增行不应再播报
    node.scrollTop = 120
    await scrollNode(node)
    expect(liveMode()).toBe('off')

    // 回到底部恢复跟随：重新播报
    node.scrollTop = 1000
    await scrollNode(node)
    expect(liveMode()).toBe('polite')
  })

  it('mutes the live region while log reading is paused', async () => {
    await renderConsole(initialLogs, { paused: true })
    expect(liveMode()).toBe('off')
  })

  it('resumes following and clears the count from the indicator click', async () => {
    await renderConsole(initialLogs)
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 120
    await scrollNode(node)
    await renderConsole([...initialLogs, entry('新增一')])

    const indicator = findFollowIndicator()
    expect(indicator?.textContent).toBe('有新日志')
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
    // 历史视图没有新增行可播报，实时区域应保持静音
    expect(liveMode()).toBe('off')
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)

    node.scrollTop = 100
    await scrollNode(node)
    expect(findFollowIndicator()).toBeUndefined()

    await renderConsole([...historyLogs, entry('历史三')], { viewingHistory: true, autoScroll: true })
    expect(node.scrollTop).toBe(100)
  })
  it('keeps following when repeat grouping changes the rendered height', async () => {
    const repeated = [
      { ...entry('执行命令: maa fight, 等待完成: true'), id: 'event-1' },
      { ...entry('执行命令: maa fight, 等待完成: true'), id: 'event-2' },
    ]
    const view = (collapseRepeats: boolean) => buildLogView(repeated, {
      events: 'all', level: 'all', search: '', collapseRepeats,
    })
    await renderConsole(repeated, { view: view(true) })
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)
    node.scrollTop = 500
    await renderConsole(repeated, { view: view(false) })
    expect(node.scrollTop).toBe(1000)
    node.scrollTop = 500
    await renderConsole(repeated, { view: view(true) })
    expect(node.scrollTop).toBe(1000)
    expect(findFollowIndicator()).toBeUndefined()
  })

  it('preserves a paused position when repeat grouping changes', async () => {
    const repeated = [
      { ...entry('执行命令: maa fight, 等待完成: true'), id: 'event-1' },
      { ...entry('执行命令: maa fight, 等待完成: true'), id: 'event-2' },
    ]
    const view = (collapseRepeats: boolean) => buildLogView(repeated, {
      events: 'all', level: 'all', search: '', collapseRepeats,
    })
    await renderConsole(repeated, { view: view(true) })
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)
    node.scrollTop = 120
    await scrollNode(node)
    await renderConsole(repeated, { view: view(false) })
    expect(node.scrollTop).toBe(120)
    expect(findFollowIndicator()?.textContent).toBe('回到底部')
    await renderConsole(repeated, { view: view(true) })
    expect(node.scrollTop).toBe(120)
    expect(findFollowIndicator()?.textContent).toBe('回到底部')
  })

  it('does not mark equal selected facts unread and resets when the scope changes', async () => {
    await renderConsole(initialLogs, { scopeKey: 'run-1' })
    const node = getLogNode()
    defineScrollBox(node, 1000, 400)
    node.scrollTop = 120
    await scrollNode(node)
    await renderConsole(initialLogs.map(log => ({ ...log })), { scopeKey: 'run-1' })
    expect(findFollowIndicator()?.textContent).toBe('回到底部')
    await renderConsole([...initialLogs, entry('新增一')], { scopeKey: 'run-1' })
    expect(findFollowIndicator()?.textContent).toBe('有新日志')
    await renderConsole([entry('另一执行')], { scopeKey: 'run-2' })
    expect(findFollowIndicator()).toBeUndefined()
  })

})

describe('LogConsole record details', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps exact source, full timestamp and correlation in expandable details', async () => {
    const record: LogEntry = {
      ...entry('执行命令: maa fight, 等待完成: true'),
      id: 'event-1',
      timestamp: '2026-11-03T10:00:00.123Z',
      sourceText: '[2026-11-03 10:00:00.123][INF][thread-1] 执行命令: maa fight, 等待完成: true',
      source: 'realtime',
      runId: 'run-1',
      operationId: 'op-1',
    }
    await renderConsole([record], {
      view: buildLogView([record], { events: 'all', level: 'all', search: '', collapseRepeats: true }),
    })
    expect(container.querySelector('summary')?.textContent).toBe('原文与详情')
    expect(container.querySelector('pre')?.textContent).toBe(record.sourceText)
    expect(container.textContent).toContain('2026-11-03T10:00:00.123Z')
    expect(container.textContent).toContain('Run：run-1 · Operation：op-1')
  })
})
