/**
 * 数据统计域 API 端点
 * 仓库/干员识别数据、掉落统计与今日开放关卡。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'

export const getItemIconUrl = (iconId: string | number): string =>
  `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/refs/heads/main/item/${encodeURIComponent(String(iconId))}.png`

/**
 * 解析并保存仓库数据
 */
export async function parseDepotData(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/depot-recognition`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

/**
 * 解析并保存干员数据
 */
export async function parseOperBoxData(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/actions/operbox-recognition`, {
    method: 'POST',
  })
  return parseJsonResponse(response)
}

const isDepotPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.items))

const isOperBoxPayload = (payload: unknown): boolean =>
  payload === null || (isRecord(payload) && Array.isArray(payload.data))

/**
 * 今日掉落有两条既有形状：`/drops/today` 的日记录对象，以及旧版/仪表盘消费的
 * 记录数组。两者都是合法载荷；业务错误信封仍必须失败。
 */
const isTodayDropsPayload = (payload: unknown): boolean =>
  Array.isArray(payload)
  || (isRecord(payload)
    && payload.success !== false
    && Array.isArray(payload.records)
    && isRecord(payload.summary))

/**
 * `dailyTrend` 不由掉落面板消费；旧服务端/固定数据可能省略，不能据此判坏。
 */
const isDropStatisticsPayload = (payload: unknown): boolean =>
  isRecord(payload)
  && payload.success !== false
  && isRecord(payload.total)
  && isRecord(payload.items)
  && isRecord(payload.stages)
  && (payload.dailyTrend === undefined || Array.isArray(payload.dailyTrend))

const isOpenTodayStagesPayload = (payload: unknown): boolean =>
  isRecord(payload)
  && Array.isArray(payload.open)
  && Array.isArray(payload.closed)

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
 * 获取今日掉落记录
 */
export async function getTodayDrops(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/drops/today`, {
    signal,
    validate: isTodayDropsPayload,
    invalidPayloadMessage: '今日掉落记录格式不正确',
  })
}

/**
 * 获取掉落统计数据
 */
export async function getDropStatistics(days: number = 7, signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/drops/statistics?days=${days}`, {
    signal,
    validate: isDropStatisticsPayload,
    invalidPayloadMessage: '掉落统计数据格式不正确',
  })
}

export async function getOpenTodayStages(signal?: AbortSignal): Promise<ApiResponse> {
  return readApiResponse(`${API_BASE_URL}/agent/stages/open-today`, {
    signal,
    validate: isOpenTodayStagesPayload,
    invalidPayloadMessage: '今日开放关卡数据格式不正确',
  })
}
