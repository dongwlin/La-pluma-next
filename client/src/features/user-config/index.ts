/**
 * 用户配置微域公开面
 * 跨域共用的用户任务配置读写端点，以及按配置 key 串行的持久化协调器。
 */

export { loadUserConfig, saveUserConfig } from './api'

export { USER_CONFIG_KEYS, USER_CONFIG_PENDING_KEYS } from './model/configKeys'
export type { UserConfigKey } from './model/configKeys'

export {
  DEFAULT_RESTORED_MESSAGE,
  UserConfigCoordinator,
  createConfigKeyStorage,
  userConfigCoordinator,
} from './model/configCoordinator'
export type {
  ConfigChannel,
  ConfigCommitResult,
  ConfigCoordinatorState,
  ConfigKeyStorage,
  ConfigLoadResult,
  ConfigPersistenceAdapter,
  ConfigReloadOutcome,
  ConfigReloadReason,
  ConfigSettleResult,
  ConfigSyncState,
  UserConfigCoordinatorOptions,
} from './model/configCoordinator'

export { useUserConfig } from './hooks/useUserConfig'
export type { UseUserConfigOptions, UseUserConfigResult } from './hooks/useUserConfig'
