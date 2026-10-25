/**
 * 养成设置所有者的 React 适配层
 *
 * 设置状态、本地 revision 与串行写链由模块级 `TrainingSettingsOwner` 持有；
 * 本 hook 只订阅状态并暴露编辑/采用入口。Activity 隐藏或页面重挂载不会重建
 * 所有者，因此旧提交仍排在新提交之前。
 */

import { useCallback, useSyncExternalStore } from 'react'
import {
  trainingSettingsOwner,
  type TrainingSettingsOwner,
  type TrainingSettingsOwnerState,
  type TrainingSettingsWriteOutcome,
} from '../model/settingsCommands'
import type { TrainingSettings } from '../types'

export interface TrainingSettingsController extends TrainingSettingsOwnerState {
  readonly update: (settings: TrainingSettings) => Promise<TrainingSettingsWriteOutcome>
  readonly hydrate: (settings?: TrainingSettings | null) => boolean
  readonly adopt: (settings?: TrainingSettings | null) => boolean
  readonly readState: () => TrainingSettingsOwnerState
}

export function useTrainingSettings(
  owner: TrainingSettingsOwner = trainingSettingsOwner,
): TrainingSettingsController {
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)

  const update = useCallback(
    (settings: TrainingSettings) => owner.update(settings),
    [owner],
  )
  const hydrate = useCallback(
    (settings?: TrainingSettings | null) => owner.hydrate(settings),
    [owner],
  )
  const adopt = useCallback(
    (settings?: TrainingSettings | null) => owner.adopt(settings),
    [owner],
  )
  const readState = useCallback(() => owner.getState(), [owner])

  return {
    settings: state.settings,
    persisted: state.persisted,
    revision: state.revision,
    syncState: state.syncState,
    error: state.error,
    update,
    hydrate,
    adopt,
    readState,
  }
}
