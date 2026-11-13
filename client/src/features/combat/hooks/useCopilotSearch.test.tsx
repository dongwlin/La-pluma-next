// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSearchRequest } from '../model/copilotDiscovery'
import type { CopilotSearchResult } from '../types'
import { useCopilotSearch, type UseCopilotSearchResult } from './useCopilotSearch'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  searchCopilot: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  searchCopilot: mocks.searchCopilot,
}))

const REQUEST: CopilotSearchRequest = {
  keyword: '1-7',
  level: '',
  includedOperators: [],
  excludedOperators: [],
  orderBy: 'hot',
  page: 1,
  limit: 30,
}

const pageResult = (page: number, hasNext: boolean): CopilotSearchResult => ({
  stage: '1-7',
  page,
  limit: 30,
  total: 150,
  hasNext,
  copilots: [{
    id: `page-${page}`,
    uri: `prts://page-${page}`,
    views: 1,
    hotScore: 0,
  }],
})

const envelope = (page: number, hasNext: boolean) => ({
  success: true,
  data: pageResult(page, hasNext),
})

let container: HTMLDivElement
let root: Root
let client: QueryClient
const renders: Array<UseCopilotSearchResult<CopilotSearchRequest, CopilotSearchResult>> = []

const latest = () => renders[renders.length - 1]

function Probe() {
  renders.push(useCopilotSearch(REQUEST))
  return null
}

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const renderProbe = async () => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renders.length = 0
  mocks.searchCopilot.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  client.clear()
  vi.restoreAllMocks()
})

describe('useCopilotSearch', () => {
  it('loads another page without replacing the current result or the searching state', async () => {
    mocks.searchCopilot.mockImplementation(async (request: CopilotSearchRequest) => (
      request.page === 1 ? envelope(1, true) : envelope(2, false)
    ))
    await renderProbe()

    expect(latest()?.result?.page).toBe(1)

    const pageTwo: { value: CopilotSearchResult | null } = { value: null }
    await act(async () => {
      pageTwo.value = await latest()!.loadMore({ ...REQUEST, page: 2 })
    })
    await flush()

    expect(pageTwo.value?.page).toBe(2)
    expect(latest()?.result?.page).toBe(1)
    expect(latest()?.result?.copilots.map(item => item.uri)).toEqual(['prts://page-1'])
    expect(latest()?.searching).toBe(false)
    expect(mocks.searchCopilot).toHaveBeenCalledTimes(2)
    expect(mocks.searchCopilot).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
      expect.anything(),
    )
  })

  it('returns null and keeps the current result when the page request fails', async () => {
    mocks.searchCopilot.mockImplementation(async (request: CopilotSearchRequest) => (
      request.page === 1
        ? envelope(1, true)
        : { success: false, message: '读取失败' }
    ))
    await renderProbe()

    const pageTwo: { value: CopilotSearchResult | null } = { value: pageResult(9, false) }
    await act(async () => {
      pageTwo.value = await latest()!.loadMore({ ...REQUEST, page: 2 })
    })
    await flush()

    expect(pageTwo.value).toBeNull()
    expect(latest()?.result?.page).toBe(1)
    expect(latest()?.searching).toBe(false)
  })
})
