// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotDetailTarget } from '../model/copilotDetail'
import { useResolvedCopilotDetailTarget } from './useResolvedCopilotDetailTarget'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getCopilotInfo: vi.fn(),
  getCopilotSet: vi.fn(),
  getCopilotSetPlan: vi.fn(),
  searchCopilot: vi.fn(),
  searchParadoxCopilot: vi.fn(),
}))

vi.mock('../api', () => mocks)

const details = '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD'

let container: HTMLDivElement
let root: Root
let client: QueryClient
const renders: Array<CopilotDetailTarget | null> = []

function Probe({ target }: { target: CopilotDetailTarget | null }) {
  renders.push(useResolvedCopilotDetailTarget(target))
  return null
}

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const renderProbe = async (target: CopilotDetailTarget | null) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe target={target} />
      </QueryClientProvider>,
    )
  })
  await flush()
}

const latest = () => renders[renders.length - 1] ?? null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renders.length = 0
  mocks.getCopilotInfo.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  client.clear()
  vi.restoreAllMocks()
})

describe('useResolvedCopilotDetailTarget', () => {
  it('loads the description for a queue entry persisted without one', async () => {
    mocks.getCopilotInfo.mockResolvedValue({
      success: true,
      data: {
        status_code: 200,
        data: {
          content: JSON.stringify({
            stage_name: 'act55side_ex03',
            doc: { title: 'TL-EX-3', details },
          }),
        },
      },
    })

    await renderProbe({ title: 'TL-EX-3', uri: 'prts://109596' })

    expect(mocks.getCopilotInfo).toHaveBeenCalledWith('109596', expect.anything())
    expect(latest()?.details).toBe(details)
  })

  it('reuses the description the target already carries', async () => {
    await renderProbe({ title: '作业', uri: 'prts://101', details: '已有描述' })

    expect(mocks.getCopilotInfo).not.toHaveBeenCalled()
    expect(latest()?.details).toBe('已有描述')
  })

  it('does not fetch for set links, local files or a closed layer', async () => {
    await renderProbe({ title: '作业集', uri: 'prts://s48990' })
    await renderProbe({ title: '本地作业', uri: '/data/a.json' })
    await renderProbe(null)

    expect(mocks.getCopilotInfo).not.toHaveBeenCalled()
    expect(latest()).toBeNull()
  })

  it('keeps the target unchanged when the description cannot be read', async () => {
    mocks.getCopilotInfo.mockRejectedValue(new Error('offline'))

    await renderProbe({ title: '作业', uri: 'prts://101' })

    expect(latest()).toEqual({ title: '作业', uri: 'prts://101' })
  })
})
