/**
 * 养成计划所有者的 React 适配层
 *
 * 生成/应用/同步编排、版本裁决与失效发布由模块级 `TrainingPlanOwner` 持有；
 * 本 hook 只注入应用级 QueryClient、设置所有者与队列 pending 状态，并订阅
 * 状态。Activity 隐藏或页面重挂载不会重建所有者或取消已发出的写请求。
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { trainingKeys } from '../model/queryKeys'
import { trainingQueueQueryOptions } from '../model/queries'
import {
  trainingPlanOwner,
  type TrainingPlanApplyOutcome,
  type TrainingPlanGenerateOutcome,
  type TrainingPlanOwner,
  type TrainingPlanOwnerState,
  type TrainingPlanQueueContext,
  type TrainingPlanSyncOutcome,
} from '../model/planCommands'
import type { TrainingFlowSync, TrainingPlanMode, TrainingQueueSnapshot } from '../types'
import { trainingQueueCommandOwner } from '../model/queueCommands'
import { useTrainingSettings } from './useTrainingSettings'

export interface TrainingPlanController extends TrainingPlanOwnerState {
  readonly generating: boolean
  readonly applying: boolean
  readonly syncing: boolean
  readonly generate: (mode: TrainingPlanMode) => Promise<TrainingPlanGenerateOutcome>
  readonly apply: () => Promise<TrainingPlanApplyOutcome>
  readonly retrySync: () => Promise<TrainingPlanSyncOutcome>
  readonly reload: () => Promise<TrainingQueueSnapshot | null>
  readonly invalidate: () => void
  readonly recordFlowSync: (flowSync?: TrainingFlowSync) => void
}

export function useTrainingPlan(
  owner: TrainingPlanOwner = trainingPlanOwner,
): TrainingPlanController {
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
  const { adopt: adoptSettings, hydrate: hydrateSettings } = useTrainingSettings()

  // 只读观察者：用于取得队列刷新失败标记与首屏快照；写入仍归队列命令。
  const queueOptions = useMemo(() => trainingQueueQueryOptions(), [])
  const queueQuery = useQuery(queueOptions)
  const queueSnapshot = queueQuery.data

  // 操作发生时直接读 Query 缓存与命令所有者状态，避免在渲染期写 ref。
  const isRefreshFailed = useCallback(() => {
    const state = queryClient.getQueryState<TrainingQueueSnapshot>(
      trainingKeys.resource('queue'),
    )
    const data = state?.data
    return Boolean(data?.uncertain) || (state?.status === 'error' && Boolean(data))
  }, [queryClient])

  const refetchQueue = useCallback(async (): Promise<TrainingQueueSnapshot | null> => {
    try {
      // 取消开始于本次读取之前的在途读取，避免旧快照在写入后落地。
      await queryClient.cancelQueries({
        queryKey: trainingKeys.resource('queue'),
        exact: true,
      })
      // fetchQuery 直接返回权威载荷；staleTime 0 强制发起新读取，失败以异常返回。
      return await queryClient.fetchQuery({
        ...trainingQueueQueryOptions(),
        staleTime: 0,
      })
    } catch {
      return null
    }
  }, [queryClient])

  const context = useMemo<TrainingPlanQueueContext>(() => ({
    getSnapshot: () => queryClient.getQueryData<TrainingQueueSnapshot>(
      trainingKeys.resource('queue'),
    ),
    refetch: refetchQueue,
    isRefreshFailed,
    isQueueMutationPending: () => trainingQueueCommandOwner.getState().pending.length > 0,
    adoptSettings,
  }), [queryClient, refetchQueue, isRefreshFailed, adoptSettings])

  // 队列快照变化（首屏、后台重取、外部队列）统一由所有者观察：
  // revision 变化作废旧计划，空闲时采用最新 flowSync。
  useEffect(() => {
    owner.observeQueueSnapshot(queueSnapshot)
  }, [owner, queueSnapshot])

  // 首次成功快照把服务端设置交给设置所有者；用户先编辑时 hydrate 自带保护。
  useEffect(() => {
    if (queueSnapshot) hydrateSettings(queueSnapshot.settings)
  }, [queueSnapshot, hydrateSettings])

  const generate = useCallback(
    (mode: TrainingPlanMode) => owner.generate(mode, context),
    [owner, context],
  )
  const apply = useCallback(() => owner.apply(context), [owner, context])
  const retrySync = useCallback(() => owner.retrySync(context), [owner, context])
  const reload = useCallback(() => owner.reload(context), [owner, context])
  const invalidate = useCallback(() => owner.invalidate(), [owner])
  const recordFlowSync = useCallback(
    (flowSync?: TrainingFlowSync) => owner.recordFlowSync(flowSync),
    [owner],
  )


  return {
    ...state,
    generating: state.operation === 'generate',
    applying: state.operation === 'apply',
    syncing: state.operation === 'sync',
    generate,
    apply,
    retrySync,
    reload,
    invalidate,
    recordFlowSync,
  }
}
