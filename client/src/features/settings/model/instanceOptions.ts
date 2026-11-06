// 实例选项与连接配置同属一个 MAA profile，但各自持有草稿：保存只提交
// instance_options 段，服务端按 section 合并，因此两个表单不会互相覆盖。

import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  isRecord,
  unwrapApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getConfig, saveConfig } from '../api'
import type { MaaInstanceOptions } from '../types'
import { ConfigDraftOwner } from './configDraftOwner'
import type { ConfigDraftState, ConfigSaveOutcome, ConfigSnapshot } from './configDraftOwner'
import {
  DEFAULT_INSTANCE_OPTIONS,
  normalizeInstanceOptionsConfig,
} from './configNormalization'
import { settingsKeys } from './queryKeys'

export type InstanceOptionsState = ConfigDraftState<MaaInstanceOptions>

export type InstanceOptionsSaveOutcome = ConfigSaveOutcome<MaaInstanceOptions>

export type InstanceOptionsSnapshot = ConfigSnapshot<MaaInstanceOptions>

export interface InstanceOptionsOwnerOptions {
  readonly profileName?: string
  readonly write?: (
    profileName: string,
    config: MaaInstanceOptions,
  ) => Promise<ApiResponse<unknown>>
}

export class InstanceOptionsOwner extends ConfigDraftOwner<MaaInstanceOptions> {
  constructor(options: InstanceOptionsOwnerOptions = {}) {
    super({
      profileName: options.profileName,
      write: options.write ?? ((profileName, config) => saveConfig(profileName, { instance_options: config })),
      normalize: normalizeInstanceOptionsConfig,
      defaultValue: () => ({ ...DEFAULT_INSTANCE_OPTIONS }),
      failureMessage: '保存实例选项失败',
    })
  }
}

export const settingsInstanceOptionsOwner = new InstanceOptionsOwner()

/** 服务端 profile 载荷：缺失 instance_options 段按空段处理，使用 MaaCore 默认值。 */
const readProfileInstanceOptions = (payload: unknown): unknown => {
  if (!isRecord(payload)) return payload
  return 'instance_options' in payload ? payload.instance_options : {}
}

export const instanceOptionsQueryOptions = (
  profileName = 'default',
  owner: InstanceOptionsOwner = settingsInstanceOptionsOwner,
) => queryOptions({
  queryKey: settingsKeys.query('maa-instance-options', profileName),
  queryFn: async ({ signal }): Promise<InstanceOptionsSnapshot> => {
    const readToken = owner.beginRead()
    const response = await getConfig(profileName, signal)
    const config = normalizeInstanceOptionsConfig(
      readProfileInstanceOptions(unwrapApiResponse<unknown>(response)),
    )
    if (!config) {
      throw new ApiRequestError({
        kind: 'contract',
        code: 'INVALID_DOMAIN_PAYLOAD',
        message: '实例选项格式不正确',
      })
    }
    return { config, readToken }
  },
})
