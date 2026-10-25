/**
 * 组件更新命令的 React 适配层
 *
 * 命令状态由模块级 `SettingsUpdateOwner` 持有；本 hook 只订阅状态、转发动作，
 * 并在命令确认成功后执行两项跨域副作用：
 *
 * - 发布 `catalog`/`materials`/`training-plan`/`dashboard-snapshot` 失效，
 *   让资源读取方按实际影响范围刷新；CLI 更新不发布；
 * - 重取同一 `settings/version` 资源，使页面版本与资源状态同步。
 *
 * 失败只展示反馈，不自动重发命令；“重试资源同步”仍是用户显式动作。
 * Activity 隐藏或卸载不取消在途命令，也不清除已完成反馈。
 */

import { useCallback, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import { settingsKeys } from '../model/queryKeys'

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
  owner: SettingsUpdateOwner = settingsUpdateOwner,
): UseSettingsUpdatesResult {
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
  const queryClient = useQueryClient()

  const run = useCallback(async (
    startMessage: string,
    action: () => Promise<UpdateCommandOutcome>,
  ): Promise<UpdateCommandOutcome> => {
    // 已有一条命令在途时不再显示第二条开始提示；owner 会返回 ignored。
    if (owner.getState().running === null) notify(startMessage)

    const outcome = await action()

    if (outcome.status === 'succeeded') {
      if (outcome.resourcesChanged) {
        publishResourceInvalidation({
          resources: SETTINGS_UPDATE_RESOURCE_SCOPES,
          cause: 'resource-update',
        })
      }
      if (outcome.versionChanged) {
        // Activity 隐藏时版本 Query 没有观察者；invalidate 会标记过期，
        // 恢复显示后按 refetchOnMount 重新读取，而不是被新鲜期挡住。
        await queryClient.invalidateQueries({ queryKey: settingsKeys.query('version') })
      }
    }

    if (outcome.message) {
      if (outcome.messageType) notify(outcome.message, outcome.messageType)
      else notify(outcome.message)
    }
    return outcome
  }, [notify, owner, queryClient])

  const updateCore = useCallback(() => (
    run('正在更新 MaaCore 并同步最新资源...', () => owner.updateCore())
  ), [owner, run])

  const switchCoreChannel = useCallback((currentCore?: string | null) => {
    const target = resolveCoreChannelSwitch(currentCore)
    return run(
      `正在切换到 ${target.label} 渠道...`,
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
