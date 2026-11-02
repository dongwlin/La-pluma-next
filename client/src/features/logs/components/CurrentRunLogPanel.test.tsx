// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import { RealtimeLogStream } from '../model/realtimeLogStream'
import CurrentRunLogPanel from './CurrentRunLogPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realtimeRow = (message: string, runId?: string) => ({
  time: '2026-07-22T10:11:12',
  level: 'INFO',
  message,
  ...(runId ? { runId } : {}),
})

const rows = (): unknown[] => [
  // 语义回调行：易读模式下应改写为摘要文案。
  realtimeRow('Assistant::append_callback | TaskChainStart {"taskchain":"Roguelike"}', 'run-1'),
  realtimeRow('开始执行：肉鸽任务', 'run-1'),
  // 其它 run 与无归属的行都不属于本次执行。
  realtimeRow('其它 run 的日志', 'run-2'),
  realtimeRow('无归属日志'),
  // DEBUG 行在易读模式下丢弃。
  { time: '2026-07-22T10:11:13', level: 'DEBUG', message: 'debug 噪音', runId: 'run-1' },
]

/** 折叠态由工作区持有：测试用同样的受控方式持有 open。 */
function Harness({
  runId,
  stream,
  onToggle,
}: {
  runId: string | null
  stream: RealtimeLogStream
  onToggle: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <CurrentRunLogPanel
      runId={runId}
      open={open}
      onToggle={() => {
        onToggle()
        setOpen(value => !value)
      }}
      stream={stream}
    />
  )
}

let container: HTMLDivElement
let root: Root

const renderPanel = async (
  stream: RealtimeLogStream,
  { runId = 'run-1', onToggle = () => {} }: { runId?: string | null; onToggle?: () => void } = {},
) => {
  await act(async () => root.render(<Harness runId={runId} stream={stream} onToggle={onToggle} />))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const flushStream = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const panel = () => container.querySelector<HTMLElement>('section[aria-label="本次执行日志"]')

const entryButton = () => Array.from(panel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  .find(button => button.textContent?.includes('查看本次日志'))

const findButton = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find(button => button.textContent?.trim() === text)

const streamWith = (data: () => unknown[]) => {
  const read = vi.fn<(lines: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
    .mockResolvedValue({ success: true, data: data() })
  return { read, stream: new RealtimeLogStream({ read }) }
}

describe('CurrentRunLogPanel', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders nothing without a tracked run id', async () => {
    const { stream } = streamWith(rows)
    await renderPanel(stream, { runId: null })

    expect(panel()).toBeNull()
  })

  it('starts collapsed with an entry button and does not poll the stream', async () => {
    const { read, stream } = streamWith(rows)
    await renderPanel(stream)

    expect(panel()).not.toBeNull()
    expect(entryButton()).toBeDefined()
    expect(entryButton()?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="log"]')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('filters realtime rows by the current run id and defaults to the readable mode', async () => {
    const { read, stream } = streamWith(rows)
    await renderPanel(stream)

    await act(async () => entryButton()?.click())
    await flushStream()

    expect(container.querySelector('[role="log"]')).not.toBeNull()
    expect(container.textContent).toContain('本次执行日志')
    // 易读模式：回调行展示语义摘要而不是原始 JSON。
    expect(container.textContent).toContain('任务开始：集成战略')
    expect(container.textContent).toContain('开始执行：肉鸽任务')
    expect(container.textContent).not.toContain('TaskChainStart')
    // 过滤：只保留当前 runId 的行。
    expect(container.textContent).not.toContain('其它 run 的日志')
    expect(container.textContent).not.toContain('无归属日志')
    expect(container.textContent).not.toContain('debug 噪音')
    expect(read).toHaveBeenCalledOnce()
  })

  it('collapses from the console heading action and reopens through the entry', async () => {
    const { stream } = streamWith(rows)
    const onToggle = vi.fn()
    await renderPanel(stream, { onToggle })

    await act(async () => entryButton()?.click())
    await flushStream()
    expect(container.querySelector('[role="log"]')).not.toBeNull()

    const collapse = findButton('收起')
    expect(collapse).toBeDefined()
    await act(async () => collapse?.click())
    // 展开入口 + 收起按钮各触发一次受控切换。
    expect(onToggle).toHaveBeenCalledTimes(2)
    await flushStream()

    expect(container.querySelector('[role="log"]')).toBeNull()
    expect(entryButton()).toBeDefined()

    await act(async () => entryButton()?.click())
    await flushStream()
    expect(container.querySelector('[role="log"]')).not.toBeNull()
  })

  it('hides the whole panel when the tracked run id is cleared while mounted', async () => {
    const { stream } = streamWith(rows)
    await renderPanel(stream)

    await act(async () => entryButton()?.click())
    await flushStream()
    expect(container.querySelector('[role="log"]')).not.toBeNull()

    await renderPanel(stream, { runId: null })
    expect(panel()).toBeNull()
  })
})
