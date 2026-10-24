/**
 * 投屏/截图预览域 API 端点
 * WebRTC 服务管理、组合启动、截图与设备状态。
 */

import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'
import type { WebrtcStatusData } from '../types'

export async function getWebrtcStatus(): Promise<ApiResponse<WebrtcStatusData>> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/webrtc/status`)
  return parseJsonResponse(response)
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

export async function getDeviceStats(address?: string): Promise<ApiResponse> {
  const qs = address ? `?address=${encodeURIComponent(address)}` : ''
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/device-stats${qs}`)
  return parseJsonResponse(response)
}
