import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  isRecord,
  unwrapApiResponse,
} from '@/shared/api'
import { getConfigDir, getVersion } from '../api'
import { settingsKeys } from './queryKeys'
import type {
  CliUpdateChannel,
  CoreUpdateChannel,
  UpdateChannels,
} from '../types'

export interface MaaResourceInfo {
  lastUpdated: string | null
  modifiedAt: string | null
  ageDays: number | null
  status: 'current' | 'stale' | 'unknown'
  message: string
}

export interface MaaVersionInfo {
  cli: string
  core: string
  raw: string
  resource?: MaaResourceInfo
  updateChannels?: UpdateChannels
}

const CORE_UPDATE_CHANNELS = ['stable', 'beta', 'alpha'] as const
const CLI_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const

const RESOURCE_STATUSES = ['current', 'stale', 'unknown'] as const

const describeContractFailure = (message: string): ApiRequestError => new ApiRequestError({
  kind: 'contract',
  code: 'INVALID_DOMAIN_PAYLOAD',
  message,
})

const normalizeResourceInfo = (value: unknown): MaaResourceInfo | undefined => {
  if (!isRecord(value)) return undefined

  const status = typeof value.status === 'string'
    && (RESOURCE_STATUSES as readonly string[]).includes(value.status)
    ? value.status as MaaResourceInfo['status']
    : 'unknown'

  return {
    lastUpdated: typeof value.lastUpdated === 'string' ? value.lastUpdated : null,
    modifiedAt: typeof value.modifiedAt === 'string' ? value.modifiedAt : null,
    ageDays: typeof value.ageDays === 'number' ? value.ageDays : null,
    status,
    message: typeof value.message === 'string' ? value.message : '',
  }
}

const normalizeUpdateChannels = (value: unknown): UpdateChannels | undefined => {
  if (!isRecord(value)) return undefined
  const core = typeof value.core === 'string'
    && (CORE_UPDATE_CHANNELS as readonly string[]).includes(value.core)
    ? value.core as CoreUpdateChannel
    : null
  const cli = typeof value.cli === 'string'
    && (CLI_UPDATE_CHANNELS as readonly string[]).includes(value.cli)
    ? value.cli as CliUpdateChannel
    : null
  if (!core || !cli) return undefined
  return { core, cli }
}

/** 只接受页面展示所需的已知字段；坏载荷返回 null 交给 Query 作为 contract 失败。 */
export const normalizeMaaVersionInfo = (value: unknown): MaaVersionInfo | null => {
  if (!isRecord(value)) return null
  if (typeof value.cli !== 'string' || typeof value.core !== 'string' || typeof value.raw !== 'string') {
    return null
  }

  const resource = normalizeResourceInfo(value.resource)
  const updateChannels = normalizeUpdateChannels(value.updateChannels)
  return {
    cli: value.cli,
    core: value.core,
    raw: value.raw,
    ...(resource ? { resource } : {}),
    ...(updateChannels ? { updateChannels } : {}),
  }
}

/**
 * 兼容服务端当前的 `{ path }` 与旧的纯字符串；空白路径视为不可用。
 */
export const normalizeConfigDirectoryPath = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.trim() ? value : null
  }
  if (isRecord(value) && typeof value.path === 'string' && value.path.trim()) {
    return value.path
  }
  return null
}

export const versionQueryOptions = () => queryOptions({
  queryKey: settingsKeys.query('version'),
  queryFn: async ({ signal }): Promise<MaaVersionInfo> => {
    const info = normalizeMaaVersionInfo(unwrapApiResponse(await getVersion(signal)))
    if (!info) throw describeContractFailure('版本信息格式不正确')
    return info
  },
})

export const configDirectoryQueryOptions = () => queryOptions({
  queryKey: settingsKeys.query('config-directory'),
  queryFn: async ({ signal }): Promise<string> => {
    const path = normalizeConfigDirectoryPath(unwrapApiResponse(await getConfigDir(signal)))
    if (!path) throw describeContractFailure('配置目录格式不正确')
    return path
  },
})
