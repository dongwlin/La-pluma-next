/**
 * 作业搜索与预览 Query 定义
 *
 * 只读资源由本域 Query 持有，执行状态仍归 task-execution 控制器：
 * - 搜索按提交的词区分缓存身份；页面显式搜索时用 `staleTime: 0` 读取，
 *   切换输入或页面隐藏时由调用方取消，旧响应只可能写入旧 key。
 * - 单作业/作业集/计划的 `queryFn` 都把 Query 的 `signal` 传到 fetch，
 *   取消保持 AbortError；失败归类沿用 shared/api。
 * - 预览是组合读取：计划优先，失败或为空时回退作业集成员 + 并发详情；
 *   无后缀输入保留旧的单作业/作业集探测。
 *
 * 预览组合本身不建立额外 key，也不写第二份资源状态；它只通过 `fetchQuery`
 * 读取/填充上面这些资源 key，由预览会话裁决哪一次响应可以展示。
 */

import { queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { ApiRequestError, unwrapApiResponse, type ApiFailureKind } from '@/shared/api'
import {
  getCopilotInfo,
  getCopilotSet,
  getCopilotSetPlan,
  searchCopilot,
  searchParadoxCopilot,
} from '../api'
import type {
  CopilotRaid,
  CopilotSearchResult,
  CopilotSetItem,
  ParadoxSearchResult,
} from '../types'
import {
  readCopilotInfoPayload,
  readCopilotPlanPayload,
  readCopilotSearchResult,
  readCopilotSetPayload,
  readParadoxSearchResult,
  type CopilotInfoPayload,
  type CopilotPlanPayload,
  type CopilotSetPayload,
} from './copilotPayload'
import {
  buildCopilotSetItemFromDetail,
  buildCopilotSetPreview,
  buildFallbackCopilotSetItem,
  buildSingleCopilotPreview,
  buildUnresolvedCopilotSetPreview,
  type CopilotPreviewOutcome,
  type CopilotPreviewTarget,
} from './copilotPreview'
import { combatKeys } from './queryKeys'

const invalidPayloadError = (message: string): ApiRequestError => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message,
  retryable: false,
})

export const copilotSearchQueryOptions = (stage: string) => queryOptions({
  queryKey: combatKeys.query('copilot-search', stage),
  queryFn: async ({ signal }): Promise<CopilotSearchResult> => {
    const payload = unwrapApiResponse(await searchCopilot(stage, signal))
    const result = readCopilotSearchResult(payload)
    if (!result) throw invalidPayloadError('作业搜索结果格式不正确')
    return result
  },
})

export const paradoxSearchQueryOptions = (operatorName: string) => queryOptions({
  queryKey: combatKeys.query('paradox-search', operatorName),
  queryFn: async ({ signal }): Promise<ParadoxSearchResult> => {
    const payload = unwrapApiResponse(await searchParadoxCopilot(operatorName, signal))
    const result = readParadoxSearchResult(payload)
    if (!result) throw invalidPayloadError('悖论模拟搜索结果格式不正确')
    return result
  },
})

export const copilotInfoQueryOptions = (copilotId: string) => queryOptions({
  queryKey: combatKeys.query('copilot', copilotId),
  queryFn: async ({ signal }): Promise<CopilotInfoPayload> => (
    readCopilotInfoPayload(unwrapApiResponse(await getCopilotInfo(copilotId, signal)))
  ),
})

export const copilotSetQueryOptions = (setId: string) => queryOptions({
  queryKey: combatKeys.query('copilot-set', setId),
  queryFn: async ({ signal }): Promise<CopilotSetPayload> => (
    readCopilotSetPayload(unwrapApiResponse(await getCopilotSet(setId, signal)))
  ),
})

export const copilotSetPlanQueryOptions = (setId: string, raid: CopilotRaid) => queryOptions({
  queryKey: combatKeys.query('copilot-set-plan', setId, raid),
  queryFn: async ({ signal }): Promise<CopilotPlanPayload> => {
    const plan = readCopilotPlanPayload(
      unwrapApiResponse(await getCopilotSetPlan(setId, raid, signal)),
    )
    if (!plan) throw invalidPayloadError('作业集计划格式不正确')
    return plan
  },
})

/**
 * 计划进度或选择前提变化后标记计划缓存失效。只失效资源作用域，
 * 不立即重取；下一次预览按默认新鲜度决定是否重新请求。
 */
export async function invalidateCopilotSetPlan(
  client: QueryClient,
  setId: string,
): Promise<void> {
  await client.invalidateQueries({ queryKey: combatKeys.query('copilot-set-plan', setId) })
}

export interface CopilotPreviewLoadOptions {
  /** 会话取消信号；Query 自身的取消由预览会话对 tracked key 调用 cancelQueries。 */
  readonly signal: AbortSignal
  /** 终态刷新等场景强制重读，不受默认 30s 新鲜期影响。 */
  readonly force: boolean
  /** 登记本次读取使用的具体 key，供会话取消。 */
  readonly track: (key: QueryKey) => void
}

export interface CopilotPreviewLoadRequest {
  readonly target: CopilotPreviewTarget
  readonly raid: CopilotRaid
}

export function describeCopilotPreviewFailure(
  error: unknown,
): { message: string; kind: ApiFailureKind | 'unknown' } {
  if (error instanceof ApiRequestError) return { message: error.message, kind: error.kind }
  if (error instanceof Error && error.message) return { message: error.message, kind: 'unknown' }
  return { message: '无法获取作业信息', kind: 'unknown' }
}

const isAborted = (context: CopilotPreviewLoadOptions): boolean => context.signal.aborted

/**
 * 组合读取一次预览。所有资源读取经 `fetchQuery` 走 Query 缓存：
 * - 显式预览在 30s 内复用同一 id/raid 的计划与详情；
 * - `force` 时把 `staleTime` 置 0，用于作业集终态后的进度刷新；
 * - 计划失败只影响本次组合，不会把作业集标记为不存在；
 *   计划与成员列表都失败时返回 failed，成功但为空才返回 empty。
 */
export async function loadCopilotPreview(
  client: QueryClient,
  request: CopilotPreviewLoadRequest,
  context: CopilotPreviewLoadOptions,
): Promise<CopilotPreviewOutcome> {
  const { target, raid } = request

  // 取消后不再发起后续读取（例如计划已返回但成员列表尚未开始）。
  const ensureActive = () => {
    if (context.signal.aborted) {
      throw new DOMException('请求已取消', 'AbortError')
    }
  }

  const fetchPlan = async () => {
    ensureActive()
    const options = copilotSetPlanQueryOptions(target.id, raid)
    context.track(options.queryKey)
    return client.fetchQuery({ ...options, ...(context.force ? { staleTime: 0 } : {}) })
  }

  const fetchSet = async () => {
    ensureActive()
    const options = copilotSetQueryOptions(target.id)
    context.track(options.queryKey)
    return client.fetchQuery({ ...options, ...(context.force ? { staleTime: 0 } : {}) })
  }

  const fetchInfo = async (copilotId: string) => {
    ensureActive()
    const options = copilotInfoQueryOptions(copilotId)
    context.track(options.queryKey)
    return client.fetchQuery({ ...options, ...(context.force ? { staleTime: 0 } : {}) })
  }

  const loadSetItems = async (ids: readonly number[]): Promise<CopilotSetItem[]> => (
    Promise.all(ids.map(async (copilotId) => {
      try {
        const info = await fetchInfo(String(copilotId))
        return info.detail
          ? buildCopilotSetItemFromDetail(copilotId, info.detail)
          : buildFallbackCopilotSetItem(copilotId)
      } catch (error) {
        if (isAborted(context)) throw error
        return buildFallbackCopilotSetItem(copilotId)
      }
    }))
  )

  const loadSingle = async (): Promise<CopilotPreviewOutcome> => {
    const info = await fetchInfo(target.id)
    if (!info.detail) return { status: 'empty', message: '作业不存在' }
    return {
      status: 'ready',
      preview: buildSingleCopilotPreview(target.id, info.detail),
      message: `已加载作业：${info.detail.title || info.detail.stage || ''}`,
    }
  }

  const loadSet = async (): Promise<CopilotPreviewOutcome> => {
    let plan: CopilotPlanPayload | null = null
    let planError: unknown = null
    try {
      plan = await fetchPlan()
    } catch (error) {
      if (isAborted(context)) return { status: 'cancelled' }
      planError = error
    }
    if (plan && plan.items.length > 0) {
      return {
        status: 'ready',
        preview: buildCopilotSetPreview(target.id, plan.items, target.autoAddS),
        message: `已加载作业集：${plan.items.length} 个作业`,
      }
    }

    let set: CopilotSetPayload | null = null
    let setError: unknown = null
    try {
      set = await fetchSet()
    } catch (error) {
      if (isAborted(context)) return { status: 'cancelled' }
      setError = error
    }
    if (set && set.ids.length > 0) {
      const copilots = await loadSetItems(set.ids)
      return {
        status: 'ready',
        preview: buildCopilotSetPreview(target.id, copilots, target.autoAddS),
        message: `已加载作业集：${copilots.length} 个作业`,
      }
    }

    if (planError && setError) {
      return { status: 'failed', ...describeCopilotPreviewFailure(setError) }
    }
    return { status: 'empty', message: '作业集不存在或为空' }
  }

  /**
   * 旧的无后缀探测：同时请求单作业与作业集，作业集优先；只有单作业时用单作业。
   * `status_code` 404/400 组合保留“按作业集处理”的历史兜底。
   */
  const loadProbe = async (): Promise<CopilotPreviewOutcome> => {
    const [infoResult, setResult] = await Promise.allSettled([fetchInfo(target.id), fetchSet()])
    if (isAborted(context)) return { status: 'cancelled' }

    const info = infoResult.status === 'fulfilled' ? infoResult.value : null
    const set = setResult.status === 'fulfilled' ? setResult.value : null
    const ids = set?.ids ?? []
    if (ids.length > 0) {
      const copilots = await loadSetItems(ids)
      if (copilots.length > 0) {
        return {
          status: 'ready',
          preview: buildCopilotSetPreview(target.id, copilots, target.autoAddS),
          message: `已识别作业集：${copilots.length} 个作业`,
        }
      }
    }
    if (info?.detail) {
      return {
        status: 'ready',
        preview: buildSingleCopilotPreview(target.id, info.detail),
        message: `已加载作业：${info.detail.title || info.detail.stage || ''}`,
      }
    }
    if (info?.statusCode === 404 && set?.statusCode === 400) {
      return {
        status: 'ready',
        preview: buildUnresolvedCopilotSetPreview(target.id, target.autoAddS),
        message: `已按作业集处理：prts://s${target.id}${target.autoAddS ? '（执行时自动添加 s 前缀）' : ''}`,
      }
    }
    return { status: 'empty', message: '未找到作业或作业集' }
  }

  try {
    switch (target.kind) {
      case 'single':
        return await loadSingle()
      case 'set':
        return await loadSet()
      case 'probe':
        return await loadProbe()
      default:
        return { status: 'empty', message: '未找到作业或作业集' }
    }
  } catch (error) {
    if (isAborted(context)) return { status: 'cancelled' }
    return { status: 'failed', ...describeCopilotPreviewFailure(error) }
  }
}
