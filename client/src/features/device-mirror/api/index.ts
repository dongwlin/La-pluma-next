/**
 * 投屏/截图预览域 API 端点
 * WebRTC 服务管理、组合启动、截图与设备状态。
 */

import {
  API_BASE_URL,
  fetchWithAuth,
  isRecord,
  parseJsonResponse,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'
import type { WebrtcStatusData } from '../types'

const isWebrtcStatusPayload = (payload: unknown): boolean => isRecord(payload)

const isDeviceStatsPayload = (payload: unknown): boolean => payload === null || isRecord(payload)

export async function getWebrtcStatus(signal?: AbortSignal): Promise<ApiResponse<WebrtcStatusData>> {
  return readApiResponse<WebrtcStatusData>(`${API_BASE_URL}/agent/webrtc/status`, {
    signal,
    validate: isWebrtcStatusPayload,
    invalidPayloadMessage: '预览服务状态格式不正确',
  })
}

export async function startWebrtc(profileId: string = 'default', deviceId: string = 'mumu-la-pluma', signal?: AbortSignal): Promise<ApiResponse<WebrtcStatusData>> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, deviceId }),
    signal
  })
  return parseJsonResponse(response)
}

export async function installWebrtc(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/install`, { method: 'POST' })
  return parseJsonResponse(response)
}

export async function startWebrtcServer(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/start-server`, { method: 'POST' })
  return parseJsonResponse(response)
}

export async function stopWebrtcServer(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/stop-server`, { method: 'POST' })
  return parseJsonResponse(response)
}

export async function startWebrtcAgent(profileId: string = 'default'): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/start-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId })
  })
  return parseJsonResponse(response)
}

export async function stopWebrtcAgent(): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/stop-agent`, { method: 'POST' })
  return parseJsonResponse(response)
}

export async function captureScreen(profileId: string = 'default', signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/screen/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
    signal
  })
  return parseJsonResponse(response)
}

export async function getDeviceStats(address?: string, signal?: AbortSignal): Promise<ApiResponse> {
  const qs = address ? `?address=${encodeURIComponent(address)}` : ''
  return readApiResponse(`${API_BASE_URL}/agent/device-stats${qs}`, {
    signal,
    validate: isDeviceStatsPayload,
    invalidPayloadMessage: '设备状态格式不正确',
  })
}
