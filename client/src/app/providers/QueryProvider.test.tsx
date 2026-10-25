// @vitest-environment jsdom

import { Activity, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { focusManager, onlineManager, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getQueryClient } from '@/shared/query'
import { QueryProvider } from './QueryProvider'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const queryMocks = vi.hoisted(() => ({
  fetchDepot: vi.fn(),
}))

const DEPOT_KEY = ['statistics', 'depot'] as const
const STALE_DEPOT_KEY = ['statistics', 'stale-depot'] as const

function DepotProbe({ label = 'depot' }: { label?: string }) {
  const { data, isPending } = useQuery({
    queryKey: DEPOT_KEY,
    queryFn: () => queryMocks.fetchDepot(),
  })

  return <span>{label}:{isPending ? 'loading' : String(data)}</span>
}

function StaleDepotProbe() {
  const { data, isStale } = useQuery({
    queryKey: STALE_DEPOT_KEY,
    queryFn: () => queryMocks.fetchDepot(),
    staleTime: 0,
  })

  return <span>{String(data ?? 'loading')}:{isStale ? 'stale' : 'fresh'}</span>
}

function PageSlot({ visible }: { visible: boolean }) {
  return visible ? <DepotProbe /> : <span>other page</span>
}

function ActivitySlot({ visible }: { visible: boolean }) {
  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <DepotProbe label="activity" />
    </Activity>
  )
}

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function flushTimers(turns = 2) {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

async function waitFor(check: () => void) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      check()
      return
    } catch {
      await flushTimers(1)
    }
  }
  check()
}

async function waitForText(text: string) {
  await waitFor(() => {
    expect(container.textContent).toContain(text)
  })
}

function mountRoot() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}

describe('QueryProvider cache lifecycle', () => {
  beforeEach(() => {
    queryMocks.fetchDepot.mockReset()
    queryMocks.fetchDepot.mockResolvedValue('depot-42')
    getQueryClient().clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    mountRoot()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    getQueryClient().clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('keeps one client and its cache across provider remounts', async () => {
    await render(
      <QueryProvider>
        <DepotProbe />
      </QueryProvider>,
    )
    await waitForText('depot:depot-42')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    container.remove()
    mountRoot()

    await render(
      <QueryProvider>
        <DepotProbe />
      </QueryProvider>,
    )
    await waitForText('depot:depot-42')

    expect(getQueryClient().getQueryData(DEPOT_KEY)).toBe('depot-42')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)
  })

  it('serves a single cache entry to every consumer of one resource key', async () => {
    await render(
      <QueryProvider>
        <DepotProbe label="a" />
        <DepotProbe label="b" />
      </QueryProvider>,
    )
    await waitForText('a:depot-42')
    expect(container.textContent).toContain('b:depot-42')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)

    await act(async () => {
      getQueryClient().setQueryData(DEPOT_KEY, 'depot-43')
    })
    await flushTimers()

    expect(container.textContent).toContain('a:depot-43')
    expect(container.textContent).toContain('b:depot-43')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)
  })

  it('keeps cached resource data when a page unmounts and remounts', async () => {
    await render(
      <QueryProvider>
        <PageSlot visible />
      </QueryProvider>,
    )
    await waitForText('depot:depot-42')

    await render(
      <QueryProvider>
        <PageSlot visible={false} />
      </QueryProvider>,
    )
    await flushTimers()
    expect(container.textContent).toContain('other page')

    await render(
      <QueryProvider>
        <PageSlot visible />
      </QueryProvider>,
    )
    await waitForText('depot:depot-42')

    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)
  })

  it('keeps cached resource data across Activity hide and show', async () => {
    await render(
      <QueryProvider>
        <ActivitySlot visible />
      </QueryProvider>,
    )
    await waitForText('activity:depot-42')

    await render(
      <QueryProvider>
        <ActivitySlot visible={false} />
      </QueryProvider>,
    )
    await flushTimers()
    await render(
      <QueryProvider>
        <ActivitySlot visible />
      </QueryProvider>,
    )
    await waitForText('activity:depot-42')

    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)
  })

  it('does not refetch stale resources when the document regains focus', async () => {
    await render(
      <QueryProvider>
        <StaleDepotProbe />
      </QueryProvider>,
    )
    await waitForText('depot-42:stale')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)

    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await flushTimers(3)

    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)
  })

  it('refetches stale resources when the network reconnects', async () => {
    queryMocks.fetchDepot
      .mockResolvedValueOnce('depot-42')
      .mockResolvedValueOnce('depot-43')

    await render(
      <QueryProvider>
        <StaleDepotProbe />
      </QueryProvider>,
    )
    await waitForText('depot-42:stale')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(1)

    await act(async () => {
      onlineManager.setOnline(false)
    })
    await flushTimers(1)
    await act(async () => {
      onlineManager.setOnline(true)
    })

    await waitForText('depot-43:stale')
    expect(queryMocks.fetchDepot).toHaveBeenCalledTimes(2)
  })
})
