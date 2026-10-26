// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/shared/api'
import {
  createDashboardSnapshotRefresher,
  type DashboardSnapshotRefresherDependencies,
} from './snapshotRefresher'
import type { DashboardBusinessSnapshot } from './snapshot'

const snapshot = (name: string): DashboardBusinessSnapshot => ({
  activitySummary: { available: true, name },
  scheduleSummary: { isRunning: false },
  trainingSummary: { count: 0, topNames: [] },
  dropSummary: { count: 0, recent: [] },
  openStageSummary: { open: [], closed: [] },
})

type Reader = (client: QueryClient) => Promise<DashboardBusinessSnapshot>
type Probe = () => Promise<unknown>
type Online = () => boolean

const createHarness = (overrides: Partial<{
  readSnapshot: Reader
  probeBackend: Probe
  isOnline: Online
}> = {}) => {
  const store = {
    startRefresh: vi.fn(),
    finishRefresh: vi.fn(),
  }
  const dependencies: DashboardSnapshotRefresherDependencies = {
    store,
    readSnapshot: overrides.readSnapshot ?? vi.fn(async () => snapshot('默认快照')),
    isOnline: overrides.isOnline ?? (() => true),
    probeBackend: overrides.probeBackend ?? vi.fn(async () => true),
    now: () => 1_000,
    logError: vi.fn(),
  }
  return {
    store,
    dependencies,
    refresher: createDashboardSnapshotRefresher(dependencies),
  }
}

const client = {} as QueryClient

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('dashboard snapshot refresher', () => {
  it('commits one complete snapshot with the attempt timestamp', async () => {
    const harness = createHarness()

    await harness.refresher.refresh({ client })

    expect(harness.store.startRefresh).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.probeBackend).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.readSnapshot).toHaveBeenCalledWith(client)
    expect(harness.store.finishRefresh).toHaveBeenCalledWith(1_000, snapshot('默认快照'))
  })

  it('keeps the previous snapshot when the coordinated read fails', async () => {
    const error = new Error('读取失败')
    const readSnapshot = vi.fn(async () => {
      throw error
    })
    const harness = createHarness({ readSnapshot })

    await harness.refresher.refresh({ client })

    expect(harness.store.finishRefresh).toHaveBeenCalledWith(1_000, undefined)
    expect(harness.dependencies.logError).toHaveBeenCalledWith('加载 Dashboard 数据失败:', error)
  })

  it('does not log expected request failures', async () => {
    const readSnapshot = vi.fn(async () => {
      throw new ApiRequestError({ kind: 'api', code: 'UNAVAILABLE', message: '暂时不可用' })
    })
    const harness = createHarness({ readSnapshot })

    await harness.refresher.refresh({ client })

    expect(harness.store.finishRefresh).toHaveBeenCalledWith(1_000, undefined)
    expect(harness.dependencies.logError).not.toHaveBeenCalled()
  })

  it('does not let a failed backend probe veto a complete business snapshot', async () => {
    const harness = createHarness({
      probeBackend: async () => {
        throw new Error('探针失败')
      },
    })

    await harness.refresher.refresh({ client })

    expect(harness.store.finishRefresh).toHaveBeenCalledWith(1_000, snapshot('默认快照'))
    expect(harness.dependencies.logError).not.toHaveBeenCalled()
  })

  it('records an attempt without reading anything while offline', async () => {
    const readSnapshot = vi.fn(async () => snapshot('不应读取'))
    const harness = createHarness({ readSnapshot, isOnline: () => false })

    await harness.refresher.refresh({ client })

    expect(readSnapshot).not.toHaveBeenCalled()
    expect(harness.store.startRefresh).toHaveBeenCalledTimes(1)
    expect(harness.store.finishRefresh).toHaveBeenCalledWith(1_000, undefined)
  })

  it('shares one in-flight refresh for non-force callers', async () => {
    const pending = deferred<DashboardBusinessSnapshot>()
    const readSnapshot = vi.fn(() => pending.promise)
    const harness = createHarness({ readSnapshot })

    const first = harness.refresher.refresh({ client })
    const second = harness.refresher.refresh({ client })
    await Promise.resolve()
    await Promise.resolve()

    expect(second).toBe(first)
    expect(readSnapshot).toHaveBeenCalledTimes(1)

    pending.resolve(snapshot('共享快照'))
    await first

    expect(harness.store.finishRefresh).toHaveBeenCalledTimes(1)
  })

  it('starts one follow-up read after an in-flight refresh when forced', async () => {
    const firstRead = deferred<DashboardBusinessSnapshot>()
    const secondRead = deferred<DashboardBusinessSnapshot>()
    const readSnapshot = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
    const harness = createHarness({ readSnapshot })

    const first = harness.refresher.refresh({ client })
    const forced = harness.refresher.refresh({ client, force: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(readSnapshot).toHaveBeenCalledTimes(1)

    firstRead.resolve(snapshot('第一次'))
    await first
    await Promise.resolve()
    expect(readSnapshot).toHaveBeenCalledTimes(2)

    secondRead.resolve(snapshot('第二次'))
    await forced

    expect(harness.store.finishRefresh).toHaveBeenNthCalledWith(1, 1_000, snapshot('第一次'))
    expect(harness.store.finishRefresh).toHaveBeenNthCalledWith(2, 1_000, snapshot('第二次'))
  })

  it('runs immediately when the caller is the only refresh', async () => {
    const harness = createHarness()

    await harness.refresher.refresh({ client, force: true })

    expect(harness.dependencies.readSnapshot).toHaveBeenCalledTimes(1)
    expect(harness.store.finishRefresh).toHaveBeenCalledTimes(1)
  })
})
