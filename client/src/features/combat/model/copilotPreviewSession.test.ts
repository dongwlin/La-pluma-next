// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import type { CopilotPreviewOutcome } from './copilotPreview'
import {
  CopilotPreviewSession,
  type CopilotPreviewLoader,
} from './copilotPreviewSession'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const ready = (
  name: string,
  id = '48990',
  ids = [101],
  currentIndex = 0,
): CopilotPreviewOutcome => ({
  status: 'ready',
  preview: {
    type: 'set',
    id,
    name,
    note: '包含多个关卡，将按顺序执行',
    autoAddS: true,
    copilots: ids.map(itemId => ({ id: itemId, uri: `prts://${itemId}` })),
    currentIndex,
  },
  message: `已加载作业集：${ids.length} 个作业`,
})

const request = { input: 'prts://s48990', mode: 'auto' as const, raid: 'normal' as const }

function createSession(loader: CopilotPreviewLoader) {
  const client = createQueryClient()
  const session = new CopilotPreviewSession({ client, load: loader })
  return { client, session }
}

describe('CopilotPreviewSession input and loading', () => {
  it('rejects invalid input without requesting or touching state', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
    const { session } = createSession(loader)
    session.start()

    await expect(session.load({ input: 'not-a-uri', mode: 'auto', raid: 'normal' }))
      .resolves.toMatchObject({ status: 'invalid' })

    expect(loader).not.toHaveBeenCalled()
    expect(session.getState()).toEqual({ preview: null, loading: false })
  })

  it('publishes loading and the rendered preview', async () => {
    const pending = deferred<CopilotPreviewOutcome>()
    const loader = vi.fn<CopilotPreviewLoader>(() => pending.promise)
    const { session } = createSession(loader)
    session.start()

    const loading = session.load(request)
    expect(session.getState().loading).toBe(true)
    expect(session.getState().preview).toBeNull()

    pending.resolve(ready('作业集 A'))
    await expect(loading).resolves.toMatchObject({ status: 'ready' })
    expect(session.getState()).toMatchObject({
      loading: false,
      preview: { id: '48990', name: '作业集 A' },
    })
  })

  it('keeps the previous preview when a new read fails or ends empty', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockResolvedValueOnce(ready('第一次'))
      .mockResolvedValueOnce({ status: 'failed', message: '网络错误', kind: 'transport' })
      .mockResolvedValueOnce({ status: 'empty', message: '作业集不存在或为空' })
    const { session } = createSession(loader)
    session.start()

    await session.load(request)
    await session.load(request)
    expect(session.getState().preview?.name).toBe('第一次')
    expect(session.getState().loading).toBe(false)

    await session.load(request)
    expect(session.getState().preview?.name).toBe('第一次')
  })
})

describe('CopilotPreviewSession request arbitration', () => {
  it('cancels the older read and ignores its late response', async () => {
    const first = deferred<CopilotPreviewOutcome>()
    const second = deferred<CopilotPreviewOutcome>()
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { session } = createSession(loader)
    session.start()

    const older = session.load(request)
    const newer = session.load(request)
    newer.then(() => {})
    first.resolve(ready('旧预览'))
    second.resolve(ready('新预览'))

    await expect(older).resolves.toEqual({ status: 'cancelled' })
    await expect(newer).resolves.toMatchObject({ status: 'ready' })
    expect(session.getState().preview?.name).toBe('新预览')
  })

  it('cancels every tracked query key when the next read starts', async () => {
    const client = createQueryClient()
    const cancelSpy = vi.spyOn(client, 'cancelQueries')
    const pending = deferred<CopilotPreviewOutcome>()
    const loader = vi.fn<CopilotPreviewLoader>((_request, context) => {
      context.track(['combat', 'copilot', '101'])
      context.track(['combat', 'copilot-set-plan', '48990', 'normal'])
      return pending.promise
    })
    const session = new CopilotPreviewSession({ client, load: loader })
    session.start()

    void session.load(request)
    await Promise.resolve()
    void session.load(request)
    await Promise.resolve()

    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: ['combat', 'copilot', '101'],
      exact: true,
    })
    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: ['combat', 'copilot-set-plan', '48990', 'normal'],
      exact: true,
    })

    session.clear()
    pending.resolve({ status: 'empty', message: 'cancelled' })
  })

  it('cancels an in-flight read on Activity hide and does not retry on show', async () => {
    const pending = deferred<CopilotPreviewOutcome>()
    const loader = vi.fn<CopilotPreviewLoader>(() => pending.promise)
    const { session } = createSession(loader)
    session.start()

    const loading = session.load(request)
    expect(session.getState().loading).toBe(true)
    session.stop()
    expect(session.getState()).toEqual({ preview: null, loading: false })

    pending.resolve(ready('迟到'))
    await expect(loading).resolves.toEqual({ status: 'cancelled' })
    expect(session.getState().preview).toBeNull()

    session.start()
    expect(loader).toHaveBeenCalledOnce()
  })

  it('clears the preview and cancels loading on input change', async () => {
    const first = deferred<CopilotPreviewOutcome>()
    const second = deferred<CopilotPreviewOutcome>()
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { session } = createSession(loader)
    session.start()

    const initial = session.load(request)
    first.resolve(ready('旧预览'))
    await initial

    const loading = session.load(request)
    expect(session.getState().loading).toBe(true)
    session.clear()
    expect(session.getState()).toEqual({ preview: null, loading: false })

    second.resolve(ready('迟到'))
    await expect(loading).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('CopilotPreviewSession set refresh', () => {
  it('force-refreshes silently and merges the new items into the current preview', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockResolvedValueOnce(ready('作业集 A', '48990', [101]))
      .mockResolvedValueOnce(ready('作业集 A', '48990', [101, 102]))
    const { session } = createSession(loader)
    session.start()
    await session.load(request)
    expect(session.getState().preview?.copilots).toHaveLength(1)

    const items = await session.refreshSet('48990', 'normal')

    expect(items).toEqual([
      { id: 101, uri: 'prts://101' },
      { id: 102, uri: 'prts://102' },
    ])
    expect(session.getState().preview?.copilots).toHaveLength(2)
    expect(session.getState().preview?.name).toBe('作业集 A')
    expect(session.getState().loading).toBe(false)
    expect(loader.mock.calls[1]?.[1]).toMatchObject({ force: true })
  })

  it('ignores refreshes for another set or when the current preview is single', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockResolvedValueOnce(ready('作业集 A', '48990'))
      .mockResolvedValueOnce({
        status: 'ready',
        preview: { type: 'single', id: '12', name: '单作业', operators: '临光' },
        message: '已加载作业：单作业',
      })
    const { session } = createSession(loader)
    session.start()

    await session.load(request)
    await expect(session.refreshSet('11111', 'normal')).resolves.toBeNull()

    await session.load({ input: 'prts://12', mode: 'single', raid: 'normal' })
    await expect(session.refreshSet('12', 'normal')).resolves.toBeNull()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('keeps the current preview when the refresh fails or returns no items', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockResolvedValueOnce(ready('作业集 A', '48990', [101]))
      .mockResolvedValueOnce({ status: 'failed', message: '刷新失败', kind: 'transport' })
      .mockResolvedValueOnce(ready('作业集 A', '48990', []))
    const { session } = createSession(loader)
    session.start()
    await session.load(request)

    await expect(session.refreshSet('48990', 'normal')).resolves.toBeNull()
    await expect(session.refreshSet('48990', 'normal')).resolves.toBeNull()
    expect(session.getState().preview?.copilots).toHaveLength(1)
  })
})

describe('CopilotPreviewSession progress view', () => {
  it('resets only the matching preview current index', async () => {
    const loader = vi.fn<CopilotPreviewLoader>()
      .mockResolvedValue(ready('作业集 A', '48990', [101], 3))
    const { session } = createSession(loader)
    session.start()
    await session.load(request)
    expect(session.getState().preview?.currentIndex).toBe(3)

    session.resetProgressView('48990')
    expect(session.getState().preview?.currentIndex).toBe(0)

    session.resetProgressView('11111')
    expect(session.getState().preview?.id).toBe('48990')
  })
})
