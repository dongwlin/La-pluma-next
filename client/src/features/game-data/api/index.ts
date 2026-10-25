/**
 * 游戏数据资源共享端点
 * 仓库、持有干员与干员目录同时被统计和养成页面消费，归本非页面微域持有；
 * 养成队列、设置、计划与掉落/开放关卡仍归各自页面域。
 */

import {
  API_BASE_URL,
  isRecord,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getItemIconCacheVersion } from '../model/itemIconCache'

/**
 * 物品图标来自外部静态资源仓库。函数只生成 URL，不发起请求；
 * 图片本身由浏览器 HTTP 缓存，不进入 Query 缓存。`?v=` 使用资源更新成功后
 * 推进的 epoch，避免同一路径的新图继续命中旧缓存。
 */
export const getItemIconUrl = (
  iconId: string | number,
  version: number = getItemIconCacheVersion(),
): string =>
  `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/refs/heads/main/item/${encodeURIComponent(String(iconId))}.png?v=${version}`

const isDepotPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.items))

const isOperBoxPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.data))

const isAllOperatorsPayload = (payload: unknown): boolean => Array.isArray(payload)

/**
 * 获取已保存的仓库数据
 */
export async function getDepotData(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/depot`, {
    signal,
    validate: isDepotPayload,
    invalidPayloadMessage: '仓库数据格式不正确',
  })
}

/**
 * 获取已识别的持有干员数据
 */
export async function getOperBoxData(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/operbox`, {
    signal,
    validate: isOperBoxPayload,
    invalidPayloadMessage: '干员识别结果格式不正确',
  })
}

/**
 * 获取全量干员目录
 */
export async function getAllOperators(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/data/operators`, {
    signal,
    validate: isAllOperatorsPayload,
    invalidPayloadMessage: '全量干员列表格式不正确',
  })
}
