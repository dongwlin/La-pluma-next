/**
 * 养成队列命令的 React 适配层
 *
 * 命令串行链与 pending 状态由模块级所有者持有；本 hook 只负责把应用级
 * QueryClient 的快照读写/取消能力注入命令上下文，并派生页面所需的 pending
 * 标记。Activity 隐藏或页面重挂载不会重建所有者。
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { trainingKeys } from '../model/queryKeys'
import {
  trainingQueueCommandOwner,
  type TrainingQueueCommand,
  type TrainingQueueCommandContext,
  type TrainingQueueCommandOutcome,
  type TrainingQueueCommandOwner,
  type TrainingQueueCommandState,
} from '../model/queueCommands'
import type { TrainingQueueSnapshot } from '../types'

export function useTrainingQueueCommandState(
  owner: TrainingQueueCommandOwner = trainingQueueCommandOwner,
): TrainingQueueCommandState {
  return useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
}

export interface TrainingQueueCommands {
  readonly pending: TrainingQueueCommandState['pending']
  readonly pendingOperatorIds: ReadonlySet<string>
  readonly queueMutationPending: boolean
  readonly run: (command: TrainingQueueCommand) => Promise<TrainingQueueCommandOutcome>
}

export function useTrainingQueueCommands(
  owner: TrainingQueueCommandOwner = trainingQueueCommandOwner,
): TrainingQueueCommands {
  const queryClient = useQueryClient()
  const state = useTrainingQueueCommandState(owner)

  const context = useMemo<TrainingQueueCommandContext>(() => ({
    getSnapshot: () => queryClient.getQueryData<TrainingQueueSnapshot>(
      trainingKeys.resource('queue'),
    ),
    commitSnapshot: snapshot => {
      queryClient.setQueryData(trainingKeys.resource('queue'), snapshot)
    },
    cancelReads: () => queryClient.cancelQueries({
      queryKey: trainingKeys.resource('queue'),
      exact: true,
    }),
  }), [queryClient])

  const pendingOperatorIds = useMemo(
    () => new Set(state.pending.map(entry => entry.operatorId)),
    [state.pending],
  )

  const run = useCallback(
    (command: TrainingQueueCommand) => owner.run(command, context),
    [context, owner],
  )

  return {
    pending: state.pending,
    pendingOperatorIds,
    queueMutationPending: state.pending.length > 0,
    run,
  }
}
