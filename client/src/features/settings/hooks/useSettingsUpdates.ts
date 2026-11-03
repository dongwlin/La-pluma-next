// 命令确认成功后依次：推进物品图标缓存 epoch；发布 catalog/materials/training-plan/
// dashboard-snapshot 失效（CLI 更新不发布）；重取 settings/version。完成提示在 HTTP
// 返回后立即发出，版本重取在后台继续；失败只展示反馈，不自动重发。

import { useCallback, useSyncExternalStore } from 'react'
import { invalidateItemIconCache } from '@/features/game-data'
import { publishResourceInvalidation } from '@/features/resource-invalidation'
import {
  SETTINGS_UPDATE_RESOURCE_SCOPES,
  resolveCoreChannelSwitch,
  settingsUpdateOwner,
  type SettingsUpdateOwner,
  type UpdateCommandOutcome,
  type UpdateFeedback,
  type UpdateOperation,
} from '../model/updateCommands'

type SettingsNotify = (
  message: string,
  type?: 'success' | 'error' | 'warning' | 'info' | 'default',
) => void

export interface UseSettingsUpdatesResult {
  readonly running: UpdateOperation | null
  readonly feedback: UpdateFeedback | null
  readonly busy: boolean
  readonly updateCore: () => Promise<UpdateCommandOutcome>
  readonly switchCoreChannel: (
    currentCore?: string | null,
  ) => Promise<UpdateCommandOutcome>
  readonly updateCli: () => Promise<UpdateCommandOutcome>
  readonly updateResources: () => Promise<UpdateCommandOutcome>
}

export function useSettingsUpdates(
  notify: SettingsNotify,
  reloadVersion: () => Promise<void>,
  owner: SettingsUpdateOwner = settingsUpdateOwner,
): UseSettingsUpdatesResult {
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)

  const run = useCallback(async (
    startMessage: string,
    action: () => Promise<UpdateCommandOutcome>,
  ): Promise<UpdateCommandOutcome> => {
    // 已有一条命令在途时不再显示第二条开始提示；owner 会返回 ignored。
    if (owner.getState().running === null) notify(startMessage)

    const outcome = await action()

    if (outcome.message) {
      if (outcome.messageType) notify(outcome.message, outcome.messageType)
      else notify(outcome.message)
    }

    if (outcome.status === 'succeeded') {
      if (outcome.resourcesChanged) {
        // 图片 URL 与目录/材料数据是两套缓存：先推进图标 epoch，再发布
        // 作用域，使接收方重新渲染时拿到新的 <img src>。
        invalidateItemIconCache()
        publishResourceInvalidation({
          resources: SETTINGS_UPDATE_RESOURCE_SCOPES,
          cause: 'resource-update',
        })
      }
      if (outcome.versionChanged) {
        // 版本资源的失效在后台继续；Activity 隐藏时保留失效标记，
        // 恢复显示后重取。
        await reloadVersion()
      }
    }

    return outcome
  }, [notify, owner, reloadVersion])

  const updateCore = useCallback(() => (
    run('正在更新 MaaCore 并同步最新资源（大包下载最长可能需要约 15 分钟）...', () => owner.updateCore())
  ), [owner, run])

  const switchCoreChannel = useCallback((currentCore?: string | null) => {
    const target = resolveCoreChannelSwitch(currentCore)
    return run(
      `正在切换到 ${target.label} 渠道（大包下载最长可能需要约 15 分钟）...`,
      () => owner.switchCoreChannel(currentCore),
    )
  }, [owner, run])

  const updateCli = useCallback(() => (
    run('正在更新 MAA CLI...', () => owner.updateCli())
  ), [owner, run])

  const updateResources = useCallback(() => (
    run('正在热更新资源文件...', () => owner.updateResources())
  ), [owner, run])

  return {
    running: state.running,
    feedback: state.feedback,
    busy: state.running !== null,
    updateCore,
    switchCoreChannel,
    updateCli,
    updateResources,
  }
}
