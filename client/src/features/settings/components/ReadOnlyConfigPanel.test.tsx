// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import { settingsKeys } from '../model/queryKeys'
import ReadOnlyConfigPanel from './ReadOnlyConfigPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getConfigDir: vi.fn(),
  getVersion: vi.fn(),
  openConfigDir: vi.fn(),
}))

vi.mock('../api', () => ({
  getConfigDir: mocks.getConfigDir,
  getVersion: mocks.getVersion,
  openConfigDir: mocks.openConfigDir,
}))

vi.mock('@/features/runtime-status', () => ({
  useStatusStore: (selector?: (state: { setMessage: () => void }) => unknown) => {
    const state = { setMessage: () => {} }
    return selector ? selector(state) : state
  },
}))

let container: HTMLDivElement
let root: Root
let queryClient: QueryClient

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 3; index += 1) {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

const buttonByText = (text: string) => (
  Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.trim() === text)
)

describe('ReadOnlyConfigPanel directory entry', () => {
  beforeEach(() => {
    mocks.getConfigDir.mockReset().mockResolvedValue({ success: true, data: '/tmp/la-pluma' })
    mocks.openConfigDir.mockReset().mockResolvedValue({ success: true })
    queryClient = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  })

  it('reuses stale directory cache without refetching on mount', async () => {
    // 视图只读缓存：数据已超过 30s 新鲜期也不因挂载第二个观察者触发后台重取。
    queryClient.setQueryData(
      settingsKeys.query('config-directory'),
      '/tmp/la-pluma',
      { updatedAt: Date.now() - 60_000 },
    )

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <ReadOnlyConfigPanel section="resource" />
      </QueryClientProvider>,
    ))
    await flush()

    expect(mocks.getConfigDir).not.toHaveBeenCalled()
    expect(container.textContent).toContain('当前资源来源保持不变')
    expect(buttonByText('打开目录')?.disabled).toBe(false)
  })
})
