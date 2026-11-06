// 草稿与保存由模块级 owner 持有，寿命不跟随页面：只有「读取开始后没有新编辑/新保存」
// 的快照才能采用，refresh 不覆盖未保存草稿；保存显式触发、同一时刻一次，保存期间
// 的新编辑使旧响应只能标记 superseded；重置只改草稿，不写服务端。

import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  isRecord,
  unwrapApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getConfig, saveConfig } from '../api'
import type { MaaConnectionConfig } from '../types'
import { ConfigDraftOwner } from './configDraftOwner'
import type {
  ConfigDraftState,
  ConfigReadToken,
  ConfigSaveOutcome,
  ConfigSnapshot,
  ConfigSyncState,
} from './configDraftOwner'
import {
  DEFAULT_CONNECTION_CONFIG,
  normalizeConnectionConfig,
} from './configNormalization'
import { settingsKeys } from './queryKeys'

export type ConnectionConfigSyncState = ConfigSyncState

export type ConnectionConfigState = ConfigDraftState<MaaConnectionConfig>

export type ConnectionConfigReadToken = ConfigReadToken

export type ConnectionConfigSnapshot = ConfigSnapshot<MaaConnectionConfig>

export type ConnectionConfigSaveOutcome = ConfigSaveOutcome<MaaConnectionConfig>

export interface ConnectionConfigOwnerOptions {
  readonly profileName?: string
  readonly write?: (
    profileName: string,
    config: MaaConnectionConfig,
  ) => Promise<ApiResponse<unknown>>
}

export class ConnectionConfigOwner extends ConfigDraftOwner<MaaConnectionConfig> {
  constructor(options: ConnectionConfigOwnerOptions = {}) {
    super({
      profileName: options.profileName,
      write: options.write ?? ((profileName, config) => saveConfig(profileName, { connection: config })),
      normalize: normalizeConnectionConfig,
      defaultValue: () => ({ ...DEFAULT_CONNECTION_CONFIG }),
      failureMessage: '保存连接配置失败',
    })
  }
}

export const settingsConnectionOwner = new ConnectionConfigOwner()

/** 服务端 profile 载荷在 update 前保持 unknown；缺 `connection` 键时兼容旧扁平形状。 */
const readProfileConnection = (payload: unknown): unknown => (
  isRecord(payload) && isRecord(payload.connection) ? payload.connection : payload
)

/**
 * `settings/maa-config` 读取入口。
 *
 * Query 只保存服务端只读快照；草稿合并在 owner 中完成，Query 结果不直接
 * 写回页面。约定响应必须可归一化，否则作为 contract 失败而不是空配置。
 */
export const connectionConfigQueryOptions = (
  profileName = 'default',
  owner: ConnectionConfigOwner = settingsConnectionOwner,
) => queryOptions({
  queryKey: settingsKeys.query('maa-config', profileName),
  queryFn: async ({ signal }): Promise<ConnectionConfigSnapshot> => {
    const readToken = owner.beginRead()
    const response = await getConfig(profileName, signal)
    const config = normalizeConnectionConfig(readProfileConnection(unwrapApiResponse<unknown>(response)))
    if (!config) {
      throw new ApiRequestError({
        kind: 'contract',
        code: 'INVALID_DOMAIN_PAYLOAD',
        message: '连接配置格式不正确',
      })
    }
    return { config, readToken }
  },
})
