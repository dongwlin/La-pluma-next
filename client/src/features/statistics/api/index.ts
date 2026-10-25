/**
 * 数据统计域 API 端点
 * 掉落统计、今日开放关卡与识别命令；仓库/持有干员等共享读取见 `features/game-data`。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'

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
