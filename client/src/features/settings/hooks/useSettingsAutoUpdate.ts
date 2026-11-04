import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  settingsAutoUpdateOwner,
  type AutoUpdateConfigOwner,
  type AutoUpdateConfigState,
  type AutoUpdateSaveOutcome,
} from '../model/autoUpdateConfig'
import { isValidUpdateTime } from '../model/configNormalization'
import type { AutoUpdateConfig } from '../types'

type SettingsNotify = (
  message: string,
  type?: 'success' | 'error' | 'warning' | 'info' | 'default',
) => void

export interface UseSettingsAutoUpdateResult extends AutoUpdateConfigState {
  readonly update: (patch: Partial<AutoUpdateConfig>) => void
  readonly save: () => Promise<AutoUpdateSaveOutcome>
}

export function useSettingsAutoUpdate(
  notify: SettingsNotify,
  owner: AutoUpdateConfigOwner = settingsAutoUpdateOwner,
): UseSettingsAutoUpdateResult {
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
  // 每次真正挂载读取一次；Activity 隐藏保留该标记，恢复时不会重读。
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    void owner.load().then(outcome => {
      if (!outcome.feedback) return
      notify(outcome.feedback.message, outcome.feedback.type)
    })
  }, [notify, owner])

  const update = useCallback((patch: Partial<AutoUpdateConfig>) => {
    owner.update(patch)
  }, [owner])

  const save = useCallback(async (): Promise<AutoUpdateSaveOutcome> => {
    const current = owner.getState()
    if (current.saving) return owner.save()

    // 时间无效时 owner 直接返回错误反馈，迁移前也不会先显示“正在保存”。
    if (!current.draft.enabled || isValidUpdateTime(current.draft.time)) {
      notify('正在保存自动更新设置...', 'info')
    }

    const outcome = await owner.save()
    if (outcome.feedback) {
      notify(outcome.feedback.message, outcome.feedback.type)
    }
    return outcome
  }, [notify, owner])

  return {
    ...state,
    update,
    save,
  }
}
