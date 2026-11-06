import {
  API_BASE_URL,
  isRecord,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getItemIconCacheVersion } from '../model/itemIconCache'

const GAME_ASSET_PATH = '/game-assets'

const getGameAssetBaseUrl = (): string =>
  typeof window === 'undefined' ? GAME_ASSET_PATH : `${window.location.origin}${GAME_ASSET_PATH}`

/**
 * 本地图标与头像由服务端同源资源路由提供；函数只生成 URL，不发起请求。
 * 物品图标以 MAA 资源的物品 id 为文件名，服务端同时接受 item_table 的 iconId
 * 并解析到物品 id。图片由浏览器 HTTP 缓存，不进入 Query 缓存。`?v=` 使用资源
 * 更新成功后推进的 epoch，避免同一路径的新图继续命中旧缓存。
 */
export const getItemIconUrl = (
  key: string | number,
  version: number = getItemIconCacheVersion(),
): string =>
  `${getGameAssetBaseUrl()}/item/${encodeURIComponent(String(key))}.png?v=${version}`

export type OperatorAvatarVariant = 'base' | '1' | '2'

const OPERATOR_AVATAR_SUFFIXES: Record<OperatorAvatarVariant, string> = {
  base: '',
  '1': '_1',
  '2': '_2',
}

export const getOperatorAvatarUrl = (
  operatorId: string,
  variant: OperatorAvatarVariant = 'base',
  version: number = getItemIconCacheVersion(),
): string =>
  `${getGameAssetBaseUrl()}/avatar/${encodeURIComponent(operatorId)}${OPERATOR_AVATAR_SUFFIXES[variant]}.png?v=${version}`

const isDepotPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.items))

const isOperBoxPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.data))

const isAllOperatorsPayload = (payload: unknown): boolean => Array.isArray(payload)

export async function getDepotData(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/depot`, {
    signal,
    validate: isDepotPayload,
    invalidPayloadMessage: '仓库数据格式不正确',
  })
}

export async function getOperBoxData(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/operbox`, {
    signal,
    validate: isOperBoxPayload,
    invalidPayloadMessage: '干员识别结果格式不正确',
  })
}

export async function getAllOperators(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/operators`, {
    signal,
    validate: isAllOperatorsPayload,
    invalidPayloadMessage: '全量干员列表格式不正确',
  })
}
