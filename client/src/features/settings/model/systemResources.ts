/**
 * 设置页版本与配置目录资源
 *
 * 两者都是只读服务端资源，由 `settings/version`、`settings/config-directory`
 * Query 持有；更新流程成功后可复用同一 key 重取版本，不再各自调用端点。
 * 配置目录的“打开”是带副作用的命令，不进入 Query，也不自动重取。
 */

import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  isRecord,
  unwrapApiResponse,
} from '@/shared/api'
import { getConfigDir, getVersion } from '../api'
import { settingsKeys } from './queryKeys'

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
}

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

/** 只接受页面展示所需的已知字段；坏载荷返回 null 交给 Query 作为 contract 失败。 */
export const normalizeMaaVersionInfo = (value: unknown): MaaVersionInfo | null => {
  if (!isRecord(value)) return null
  if (typeof value.cli !== 'string' || typeof value.core !== 'string' || typeof value.raw !== 'string') {
    return null
  }

  const resource = normalizeResourceInfo(value.resource)
  return {
    cli: value.cli,
    core: value.core,
    raw: value.raw,
    ...(resource ? { resource } : {}),
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
