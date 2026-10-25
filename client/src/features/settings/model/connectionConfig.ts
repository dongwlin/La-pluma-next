/**
 * MAA connection 配置的草稿、保存与服务端读取
 *
 * 读取走 `settings/maa-config` Query，草稿与保存由模块级
 * `ConnectionConfigOwner` 持有：
 *
 * - 草稿寿命不跟随页面 section 切换，Activity 隐藏或页面重挂载也不会重建；
 * - Query 返回时只有「读取开始后没有新编辑/新保存」的快照才能采用，迟到读取
 *   不会覆盖加载期间的编辑，refresh 也不会覆盖未保存草稿；
 * - 保存显式触发，同一时刻只有一次写入；保存期间的新编辑不会让旧响应把当前
 *   草稿误报为已保存；写入成功后 revision 继续推进，使保存前发出的读取失效；
 * - 重置只把草稿恢复为页面原有默认值，不写服务端；下一次显式保存才持久化。
 *
 * 保存沿用原 wire：`POST /agent/config/maa/:profileName`，请求体
 * `{ connection: snapshot }`；profile 的未知 connection 字段随快照回写。
 */

import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  unwrapApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getConfig, saveConfig } from '../api'
import type { MaaConnectionConfig } from '../types'
import {
  DEFAULT_CONNECTION_CONFIG,
  connectionConfigsEqual,
  normalizeConnectionConfig,
} from './configNormalization'
import { settingsKeys } from './queryKeys'

export type ConnectionConfigSyncState = 'idle' | 'saving' | 'failed'

export interface ConnectionConfigState {
  /** 页面当前可编辑的草稿。 */
  readonly draft: MaaConnectionConfig
  /** 最近一次服务端读取采用或成功写入的值。 */
  readonly persisted: MaaConnectionConfig
  /** 草稿可观察版本；编辑、重置、采用服务端值与保存成功都会推进。 */
  readonly revision: number
  /** 草稿与最近确认的服务端副本是否存在差异。 */
  readonly dirty: boolean
  readonly syncState: ConnectionConfigSyncState
  readonly error: string | null
  /** 是否已成功采用服务端读取或完成一次保存。 */
  readonly loaded: boolean
  readonly lastSavedAt: number | null
}

/** 一次读取开始时的草稿版本；用于丢弃迟到响应。 */
export interface ConnectionConfigReadToken {
  readonly revision: number
  readonly dirty: boolean
  readonly saving: boolean
}

export interface ConnectionConfigSnapshot {
  readonly config: MaaConnectionConfig
  readonly readToken: ConnectionConfigReadToken
}

export type ConnectionConfigSaveStatus = 'saved' | 'failed' | 'ignored'

export interface ConnectionConfigSaveOutcome {
  readonly status: ConnectionConfigSaveStatus
  readonly config: MaaConnectionConfig
  /** 保存期间出现了新编辑或新草稿，本次响应不代表当前页面值。 */
  readonly superseded: boolean
  readonly message?: string
}

export interface ConnectionConfigOwnerOptions {
  readonly profileName?: string
  readonly write?: (
    profileName: string,
    config: { connection: MaaConnectionConfig },
  ) => Promise<ApiResponse<unknown>>
}

const cloneConnectionConfig = (config: MaaConnectionConfig): MaaConnectionConfig => ({ ...config })

const resolveFailureMessage = (response: ApiResponse<unknown>): string => {
  const message = response.errorInfo?.message || response.message || response.error
  return typeof message === 'string' && message.trim() ? message : '保存连接配置失败'
}

const describeError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '保存连接配置失败'
)

/**
 * 模块级 connection 草稿所有者。
 *
 * 寿命不跟随页面：真正卸载后重挂载仍能看到未保存草稿；Activity 隐藏只清理
 * Effects，不会取消已发出的保存。测试或明确的全局重置使用 `reset()`。
 */
export class ConnectionConfigOwner {
  private readonly profileName: string
  private readonly writeRequest: NonNullable<ConnectionConfigOwnerOptions['write']>

  private state: ConnectionConfigState = {
    draft: cloneConnectionConfig(DEFAULT_CONNECTION_CONFIG),
    persisted: cloneConnectionConfig(DEFAULT_CONNECTION_CONFIG),
    revision: 0,
    dirty: false,
    syncState: 'idle',
    error: null,
    loaded: false,
    lastSavedAt: null,
  }

  private readonly listeners = new Set<() => void>()

  constructor(options: ConnectionConfigOwnerOptions = {}) {
    this.profileName = options.profileName ?? 'default'
    this.writeRequest = options.write ?? ((profileName, config) => saveConfig(profileName, config))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): ConnectionConfigState => this.state

  /** 仅用于测试与明确的全局重置；正常页面生命周期不调用。 */
  reset(): void {
    this.state = {
      draft: cloneConnectionConfig(DEFAULT_CONNECTION_CONFIG),
      persisted: cloneConnectionConfig(DEFAULT_CONNECTION_CONFIG),
      revision: 0,
      dirty: false,
      syncState: 'idle',
      error: null,
      loaded: false,
      lastSavedAt: null,
    }
    this.notify()
  }

  /** 记录一次服务端读取的起点，读取返回时交给 `adoptServer()` 裁决。 */
  beginRead(): ConnectionConfigReadToken {
    return {
      revision: this.state.revision,
      dirty: this.state.dirty,
      saving: this.state.syncState === 'saving',
    }
  }

  /**
   * 采用服务端读取结果。
   *
   * 只有读取开始后没有新编辑、没有新保存、当前也没有未保存草稿时才接受；
   * 保存成功后 revision 会推进，因此保存前发出的读取即使更晚返回也会被丢弃。
   */
  adoptServer(snapshot: ConnectionConfigSnapshot): boolean {
    const normalized = normalizeConnectionConfig(snapshot.config)
    if (!normalized) return false
    if (this.state.syncState === 'saving') return false
    if (snapshot.readToken.saving) return false
    if (snapshot.readToken.revision !== this.state.revision) return false
    if (snapshot.readToken.dirty || this.state.dirty) return false

    const changed = !connectionConfigsEqual(normalized, this.state.draft)
    const persistedChanged = !connectionConfigsEqual(normalized, this.state.persisted)
    const loaded = this.state.loaded
    if (!changed && !persistedChanged && loaded) return false

    this.state = {
      ...this.state,
      draft: changed ? normalized : this.state.draft,
      persisted: normalized,
      revision: changed ? this.state.revision + 1 : this.state.revision,
      syncState: 'idle',
      error: null,
      loaded: true,
    }
    this.notify()
    return changed
  }

  /** 接受一次字段编辑；内容未变化时不推进 revision。 */
  update(patch: Partial<MaaConnectionConfig>): boolean {
    const next = { ...this.state.draft, ...patch }
    if (connectionConfigsEqual(next, this.state.draft)) return false

    this.state = {
      ...this.state,
      draft: next,
      revision: this.state.revision + 1,
      dirty: !connectionConfigsEqual(next, this.state.persisted),
      syncState: this.state.syncState === 'saving' ? 'saving' : 'idle',
      error: null,
    }
    this.notify()
    return true
  }

  /**
   * 恢复页面原有默认值。只改草稿，不写服务端；即使内容没变也推进 revision，
   * 使重置前发出的读取不能把服务端旧值带回来。保存进行中时忽略。
   */
  restoreDefaults(): boolean {
    if (this.state.syncState === 'saving') return false

    const next = cloneConnectionConfig(DEFAULT_CONNECTION_CONFIG)
    const changed = !connectionConfigsEqual(next, this.state.draft)
    this.state = {
      ...this.state,
      draft: next,
      revision: this.state.revision + 1,
      dirty: !connectionConfigsEqual(next, this.state.persisted),
      syncState: 'idle',
      error: null,
    }
    this.notify()
    return changed
  }

  /**
   * 显式保存当前草稿。
   *
   * 保存期间允许继续编辑：响应返回时只有 revision 未变才把当前草稿视为
   * 已保存；否则返回 `superseded`，页面保留新草稿并提示尚未保存。
   */
  async save(): Promise<ConnectionConfigSaveOutcome> {
    if (this.state.syncState === 'saving') {
      return {
        status: 'ignored',
        config: this.state.draft,
        superseded: false,
      }
    }

    const snapshot = cloneConnectionConfig(this.state.draft)
    const revisionAtStart = this.state.revision
    this.state = {
      ...this.state,
      syncState: 'saving',
      error: null,
    }
    this.notify()

    let response: ApiResponse<unknown> | null = null
    let failure: string | null = null
    try {
      response = await this.writeRequest(this.profileName, { connection: snapshot })
      if (!response.success) {
        failure = resolveFailureMessage(response)
      }
    } catch (error) {
      failure = describeError(error)
    }

    if (!failure && response?.success) {
      const superseded = revisionAtStart !== this.state.revision
      this.state = {
        ...this.state,
        persisted: snapshot,
        revision: this.state.revision + 1,
        dirty: !connectionConfigsEqual(this.state.draft, snapshot),
        syncState: 'idle',
        error: null,
        loaded: true,
        lastSavedAt: Date.now(),
      }
      this.notify()
      return { status: 'saved', config: snapshot, superseded }
    }

    const message = failure ?? '保存连接配置失败'
    const superseded = revisionAtStart !== this.state.revision
    this.state = {
      ...this.state,
      syncState: 'failed',
      error: message,
    }
    this.notify()
    return {
      status: 'failed',
      config: this.state.draft,
      superseded,
      message,
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export const settingsConnectionOwner = new ConnectionConfigOwner()

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
    const config = normalizeConnectionConfig(unwrapApiResponse<unknown>(response))
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
