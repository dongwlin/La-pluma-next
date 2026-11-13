import { API_BASE_URL, fetchWithAuth, parseJsonResponse, type ApiResponse } from '@/shared/api'

export async function saveUserConfig(configType: string, data: any): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/user/${configType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  return parseJsonResponse(response)
}

export async function loadUserConfig(configType: string, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetchWithAuth(`${API_BASE_URL}/agent/config/user/${configType}`, { signal })
  return parseJsonResponse(response)
}
