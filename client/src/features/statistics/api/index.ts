/**
 * 数据统计域 API 端点
 * 仓库/干员识别数据、掉落统计与今日开放关卡。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

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

/**
 * 获取已保存的仓库数据
 */
export async function getDepotData(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/data/depot`)
  return parseJsonResponse(response)
}

/**
 * 获取已识别的持有干员数据
 */
export async function getOperBoxData(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/data/operbox`)
  return parseJsonResponse(response)
}

/**
 * 获取今日掉落记录
 */
export async function getTodayDrops(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/drops/today`)
  return parseJsonResponse(response)
}

/**
 * 获取掉落统计数据
 */
export async function getDropStatistics(days: number = 7): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/drops/statistics?days=${days}`)
  return parseJsonResponse(response)
}

export async function getOpenTodayStages(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/stages/open-today`)
  return parseJsonResponse(response)
}
