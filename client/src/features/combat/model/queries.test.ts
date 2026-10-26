// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import { combatKeys } from './queryKeys'
import {
  copilotInfoQueryOptions,
  copilotSearchQueryOptions,
  copilotSetPlanQueryOptions,
  copilotSetQueryOptions,
  loadCopilotPreview,
  paradoxSearchQueryOptions,
  type CopilotPreviewLoadOptions,
} from './queries'

const mocks = vi.hoisted(() => ({
  searchCopilot: vi.fn(),
  searchParadoxCopilot: vi.fn(),
  getCopilotInfo: vi.fn(),
  getCopilotSet: vi.fn(),
  getCopilotSetPlan: vi.fn(),
}))

vi.mock('../api', () => mocks)

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data })
const failed = (message: string): ApiResponse => ({
  success: false,
  error: message,
  message,
  errorInfo: { code: 'AGENT_COPILOT_NOT_FOUND', message, kind: 'api', retryable: false },
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const detailResponse = (title: string, stage: string) => ok({
  status_code: 200,
  data: { content: JSON.stringify({ doc: { title }, stage_name: stage }) },
})

const loadContext = (): CopilotPreviewLoadOptions & { keys: unknown[] } => {
  const keys: unknown[] = []
  return {
    keys,
    signal: new AbortController().signal,
    force: false,
    track: key => keys.push(key),
  }
}

describe('combat query identities', () => {
  it('uses the documented domain/resource/params hierarchy', () => {
    expect(combatKeys.query('copilot-search', '1-7'))
      .toEqual(['combat', 'copilot-search', '1-7'])
    expect(combatKeys.query('paradox-search', '古米'))
      .toEqual(['combat', 'paradox-search', '古米'])
    expect(combatKeys.query('copilot', '12')).toEqual(['combat', 'copilot', '12'])
    expect(combatKeys.query('copilot-set', '48990'))
      .toEqual(['combat', 'copilot-set', '48990'])
    expect(combatKeys.query('copilot-set-plan', '48990', 'both'))
      .toEqual(['combat', 'copilot-set-plan', '48990', 'both'])
  })
})

describe('combat search queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the Query signal to the search endpoint and caches by term', async () => {
    mocks.searchCopilot.mockResolvedValue(ok({
      stage: '1-7',
      copilots: [{ id: 1, uri: 'prts://1', views: 2, hotScore: 3 }],
      recommended: { uri: 'prts://1' },
    }))
    const client = createQueryClient()

    const result = await client.fetchQuery(copilotSearchQueryOptions('1-7'))
    await client.fetchQuery(copilotSearchQueryOptions('1-7'))

    expect(result.copilots).toEqual([
      { id: '1', uri: 'prts://1', views: 2, hotScore: 3 },
    ])
    expect(mocks.searchCopilot).toHaveBeenCalledOnce()
    const signal = mocks.searchCopilot.mock.calls[0]?.[1] as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
  })

  it('cancels the fetch with the Query signal and reports API failures', async () => {
    const request = deferred<ApiResponse>()
    mocks.searchCopilot.mockReturnValueOnce(request.promise)
    const client = createQueryClient()
    const options = copilotSearchQueryOptions('CE-6')

    const fetching = client.fetchQuery(options).catch(error => error)
    await Promise.resolve()
    await Promise.resolve()
    const signal = mocks.searchCopilot.mock.calls[0]?.[1] as AbortSignal
    await client.cancelQueries({ queryKey: options.queryKey })
    expect(signal.aborted).toBe(true)
    await fetching

    mocks.searchCopilot.mockResolvedValueOnce(failed('未找到关卡"CE-6"的作业'))
    await expect(client.fetchQuery(copilotSearchQueryOptions('CE-6')))
      .rejects.toMatchObject({ name: 'ApiRequestError', kind: 'api', message: '未找到关卡"CE-6"的作业' })
  })

  it('turns a malformed search payload into a contract failure', async () => {
    mocks.searchCopilot.mockResolvedValueOnce(ok({ stage: 'CE-6', copilots: 'bad' }))
    const client = createQueryClient()

    await expect(client.fetchQuery(copilotSearchQueryOptions('CE-6')))
      .rejects.toMatchObject({ kind: 'contract', code: 'INVALID_DOMAIN_PAYLOAD' })
  })

  it('forwards the signal for paradox search and keeps the operator name', async () => {
    mocks.searchParadoxCopilot.mockResolvedValue(ok({
      operator: '古米',
      copilots: [{ id: 7, uri: 'prts://7' }],
    }))
    const client = createQueryClient()

    const result = await client.fetchQuery(paradoxSearchQueryOptions('古米'))

    expect(result.operator).toBe('古米')
    expect(mocks.searchParadoxCopilot).toHaveBeenCalledWith('古米', expect.any(AbortSignal))
  })
})

describe('combat detail queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards signals and parses the proxy envelopes', async () => {
    mocks.getCopilotInfo.mockResolvedValue(detailResponse('作业 A', '1-7'))
    mocks.getCopilotSet.mockResolvedValue(ok({ status_code: 200, data: { copilot_ids: [101] } }))
    mocks.getCopilotSetPlan.mockResolvedValue(ok({
      setId: '48990',
      name: '作业集',
      items: [{ id: 101, stage: 'TEST-1' }],
      entries: [],
    }))
    const client = createQueryClient()

    const info = await client.fetchQuery(copilotInfoQueryOptions('12'))
    const set = await client.fetchQuery(copilotSetQueryOptions('48990'))
    const plan = await client.fetchQuery(copilotSetPlanQueryOptions('48990', 'both'))

    expect(info.detail).toMatchObject({ title: '作业 A', stage: '1-7' })
    expect(set).toEqual({ statusCode: 200, ids: [101] })
    expect(plan.items[0]).toMatchObject({ id: 101, name: 'TEST-1' })
    expect(mocks.getCopilotInfo).toHaveBeenCalledWith('12', expect.any(AbortSignal))
    expect(mocks.getCopilotSet).toHaveBeenCalledWith('48990', expect.any(AbortSignal))
    expect(mocks.getCopilotSetPlan).toHaveBeenCalledWith('48990', 'both', expect.any(AbortSignal))
  })

  it('rejects a plan that lacks entries so the preview can fall back', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue(ok({ setId: '48990', items: [] }))
    const client = createQueryClient()

    await expect(client.fetchQuery(copilotSetPlanQueryOptions('48990', 'normal')))
      .rejects.toMatchObject({ kind: 'contract', code: 'INVALID_DOMAIN_PAYLOAD' })
  })
})

describe('loadCopilotPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers the plan and returns the legacy set preview', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue(ok({
      setId: '48990',
      name: '作业集',
      items: [
        { id: 101, stage: 'TEST-1', stageId: 'test_1' },
        { id: 102, stage: 'TEST-2' },
      ],
      entries: [{ itemIndex: 0, mode: 'normal', completed: true }],
    }))
    const client = createQueryClient()
    const context = loadContext()

    const outcome = await loadCopilotPreview(client, {
      target: { id: '48990', kind: 'set', autoAddS: false },
      raid: 'normal',
    }, context)

    expect(outcome).toMatchObject({
      status: 'ready',
      message: '已加载作业集：2 个作业',
      preview: {
        type: 'set',
        id: '48990',
        autoAddS: false,
        copilots: [
          { id: 101, completedModes: ['normal'] },
          { id: 102 },
        ],
      },
    })
    expect(mocks.getCopilotSet).not.toHaveBeenCalled()
    expect(mocks.getCopilotInfo).not.toHaveBeenCalled()
    expect(context.keys).toEqual([['combat', 'copilot-set-plan', '48990', 'normal']])
  })

  it('falls back to the set list and per-item details when the plan fails', async () => {
    mocks.getCopilotSetPlan.mockRejectedValue(new Error('plan unavailable'))
    mocks.getCopilotSet.mockResolvedValue(ok({ status_code: 200, data: { copilot_ids: [101, 102] } }))
    mocks.getCopilotInfo
      .mockResolvedValueOnce(detailResponse('兜底作业', 'TEST-1'))
      .mockRejectedValueOnce(new Error('detail unavailable'))
    const client = createQueryClient()

    const outcome = await loadCopilotPreview(client, {
      target: { id: '48990', kind: 'set', autoAddS: true },
      raid: 'normal',
    }, loadContext())

    expect(outcome).toMatchObject({
      status: 'ready',
      message: '已加载作业集：2 个作业',
      preview: {
        autoAddS: true,
        copilots: [
          { id: 101, name: '兜底作业', stage: 'TEST-1' },
          { id: 102, uri: 'prts://102' },
        ],
      },
    })
  })

  it('reports a failure when both plan and set reads fail', async () => {
    mocks.getCopilotSetPlan.mockRejectedValue(new Error('plan unavailable'))
    mocks.getCopilotSet.mockRejectedValue(new Error('set unavailable'))
    const client = createQueryClient()

    const outcome = await loadCopilotPreview(client, {
      target: { id: '48990', kind: 'set', autoAddS: false },
      raid: 'normal',
    }, loadContext())

    expect(outcome).toEqual({
      status: 'failed',
      message: 'set unavailable',
      kind: 'unknown',
    })
  })

  it('reports an empty set only when the reads succeed without members', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue(ok({
      setId: '48990', name: '空集', items: [], entries: [],
    }))
    mocks.getCopilotSet.mockResolvedValue(ok({ status_code: 200, data: { copilot_ids: [] } }))
    const client = createQueryClient()

    await expect(loadCopilotPreview(client, {
      target: { id: '48990', kind: 'set', autoAddS: false },
      raid: 'normal',
    }, loadContext())).resolves.toEqual({ status: 'empty', message: '作业集不存在或为空' })
  })

  it('loads a single copilot or reports that it does not exist', async () => {
    mocks.getCopilotInfo.mockResolvedValueOnce(detailResponse('单作业', '1-7'))
    const client = createQueryClient()

    await expect(loadCopilotPreview(client, {
      target: { id: '12', kind: 'single', autoAddS: true },
      raid: 'normal',
    }, loadContext())).resolves.toMatchObject({
      status: 'ready',
      message: '已加载作业：单作业',
      preview: { type: 'single', id: '12', name: '单作业' },
    })

    mocks.getCopilotInfo.mockResolvedValueOnce(ok({ status_code: 404, data: null }))
    await expect(loadCopilotPreview(client, {
      target: { id: '13', kind: 'single', autoAddS: true },
      raid: 'normal',
    }, loadContext())).resolves.toEqual({ status: 'empty', message: '作业不存在' })
  })

  it('keeps the legacy probe: set wins, single is used alone, and 404/400 falls back', async () => {
    const client = createQueryClient()
    mocks.getCopilotInfo.mockResolvedValue(detailResponse('探测单作业', '1-7'))
    mocks.getCopilotSet.mockResolvedValue(ok({ status_code: 200, data: { copilot_ids: [101] } }))
    mocks.getCopilotInfo.mockResolvedValueOnce(detailResponse('探测单作业', '1-7'))
    mocks.getCopilotSet.mockResolvedValueOnce(ok({ status_code: 200, data: { copilot_ids: [101] } }))

    const both = await loadCopilotPreview(client, {
      target: { id: '1234', kind: 'probe', autoAddS: true },
      raid: 'normal',
    }, loadContext())
    expect(both).toMatchObject({ status: 'ready', message: '已识别作业集：1 个作业', preview: { type: 'set' } })

    mocks.getCopilotInfo.mockResolvedValueOnce(detailResponse('只有单作业', '1-7'))
    mocks.getCopilotSet.mockResolvedValueOnce(ok({ status_code: 404, data: null }))
    const single = await loadCopilotPreview(client, {
      target: { id: '2345', kind: 'probe', autoAddS: true },
      raid: 'normal',
    }, loadContext())
    expect(single).toMatchObject({ status: 'ready', message: '已加载作业：只有单作业', preview: { type: 'single' } })

    mocks.getCopilotInfo.mockResolvedValueOnce(ok({ status_code: 404, data: null }))
    mocks.getCopilotSet.mockResolvedValueOnce(ok({ status_code: 400, data: null }))
    const fallback = await loadCopilotPreview(client, {
      target: { id: '3456', kind: 'probe', autoAddS: true },
      raid: 'normal',
    }, loadContext())
    expect(fallback).toMatchObject({
      status: 'ready',
      message: '已按作业集处理：prts://s3456（执行时自动添加 s 前缀）',
      preview: { type: 'set', autoAddS: true, copilots: [] },
    })

    mocks.getCopilotInfo.mockResolvedValueOnce(ok({ status_code: 404, data: null }))
    mocks.getCopilotSet.mockResolvedValueOnce(ok({ status_code: 404, data: null }))
    await expect(loadCopilotPreview(client, {
      target: { id: '4567', kind: 'probe', autoAddS: true },
      raid: 'normal',
    }, loadContext())).resolves.toEqual({ status: 'empty', message: '未找到作业或作业集' })
  })

  it('does not start the fallback set read after the caller cancels', async () => {
    const plan = deferred<ApiResponse>()
    mocks.getCopilotSetPlan.mockReturnValueOnce(plan.promise)
    const client = createQueryClient()
    const controller = new AbortController()
    const tracks: unknown[] = []

    const loading = loadCopilotPreview(client, {
      target: { id: '48990', kind: 'set', autoAddS: false },
      raid: 'normal',
    }, { signal: controller.signal, force: false, track: key => tracks.push(key) })

    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.getCopilotSetPlan).toHaveBeenCalledOnce()

    controller.abort()
    plan.resolve(ok({ setId: '48990', name: '作业集', items: [], entries: [] }))

    await expect(loading).resolves.toEqual({ status: 'cancelled' })
    expect(mocks.getCopilotSet).not.toHaveBeenCalled()
    expect(tracks).toEqual([['combat', 'copilot-set-plan', '48990', 'normal']])
  })

  it('reuses cached details unless a refresh forces a new read', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue(ok({
      setId: '48990', name: '作业集', items: [{ id: 101, stage: 'TEST-1' }], entries: [],
    }))
    const client = createQueryClient()
    const request = { target: { id: '48990', kind: 'set', autoAddS: false } as const, raid: 'normal' as const }

    await loadCopilotPreview(client, request, loadContext())
    await loadCopilotPreview(client, request, loadContext())
    expect(mocks.getCopilotSetPlan).toHaveBeenCalledOnce()

    await loadCopilotPreview(client, request, { ...loadContext(), force: true })
    expect(mocks.getCopilotSetPlan).toHaveBeenCalledTimes(2)
  })
})
