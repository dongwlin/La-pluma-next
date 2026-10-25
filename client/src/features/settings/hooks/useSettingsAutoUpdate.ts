/**
 * 自动更新策略的 React 适配层
 *
 * 草稿、读取守卫与完整提交由模块级 `AutoUpdateConfigOwner` 持有；本 hook
 * 只订阅状态、在真正挂载时读取一次策略，并把 owner 产生的反馈转发到全局
 * 状态提示。Activity 恢复不重复读取；在途保存不因 cleanup 取消。
 */

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
