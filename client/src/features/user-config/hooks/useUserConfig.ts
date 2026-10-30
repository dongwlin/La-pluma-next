/**
 * 配置协调器的薄订阅入口
 *
 * 页面用返回的 `draft` 渲染、用 `update` 接受编辑；revision/token、pending 草稿、
 * 提交队列与重试都在协调器里。hook 只负责注册适配器、订阅状态和触发首次加载，
 * 因此 Activity 隐藏/恢复或重挂载都不会创建第二份提交队列。
 */

import { useEffect, useSyncExternalStore } from 'react'
import {
  userConfigCoordinator,
  type ConfigChannel,
  type ConfigCoordinatorState,
  type ConfigPersistenceAdapter,
  type ConfigReloadOutcome,
  type UserConfigCoordinator,
} from '../model/configCoordinator'

export interface UseUserConfigOptions {
  /** 默认使用应用级单例；测试或嵌入式场景可注入独立协调器。 */
  coordinator?: UserConfigCoordinator
  /** false 时由调用方显式触发 `reload()`，例如还要等待其它资源。 */
  autoHydrate?: boolean
}

export interface UseUserConfigResult<TDraft> extends ConfigCoordinatorState<TDraft> {
  /** 直接访问通道，用于事件监听中的强制重载等非渲染场景。 */
  channel: ConfigChannel<TDraft>
  update: (draft: TDraft) => void
  retry: () => Promise<boolean>
  reload: (options?: { force?: boolean }) => Promise<ConfigReloadOutcome>
}

export function useUserConfig<TDraft, TWire>(
  adapter: ConfigPersistenceAdapter<TDraft, TWire>,
  options: UseUserConfigOptions = {},
): UseUserConfigResult<TDraft> {
  const coordinator = options.coordinator ?? userConfigCoordinator
  const autoHydrate = options.autoHydrate ?? true
  const channel = coordinator.channel(adapter)
  const state = useSyncExternalStore(channel.subscribe, channel.getState, channel.getState)

  useEffect(() => {
    if (!autoHydrate) return
    // hydrate 自带已加载守卫与单飞：StrictMode 双执行或 Activity 恢复不会重复读取。
    void channel.hydrate()
  }, [autoHydrate, channel])

  useEffect(() => () => {
    // Activity 隐藏或页面真正卸载都会清理 Effects：把去抖中的本地草稿立即落盘。
    channel.flushLocalDraft()
  }, [channel])

  return {
    ...state,
    channel,
    update: channel.setDraft,
    retry: channel.commitNow,
    reload: channel.reload,
  }
}
