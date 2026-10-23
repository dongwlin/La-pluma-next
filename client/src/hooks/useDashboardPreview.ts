import { useRef } from 'react'
import { useAutomationAvailability } from './useBackendStatusMonitor'
import { usePreviewSession } from './usePreviewSession'
import { usePreviewSnapshot } from './usePreviewSnapshot'

export function useDashboardPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { isAvailable } = useAutomationAvailability()
  const preview = usePreviewSession({
    videoRef,
    deviceId: 'mumu-la-pluma',
    signalingUrl: '/webrtc-signaling',
    automationAvailable: isAvailable,
    connectionPath: 'auto',
    ipPreference: 'ipv4',
  })
  const snapshot = usePreviewSnapshot(isAvailable)
  const showLivePreview = preview.mode === 'live' && !preview.paused && preview.status === 'connected'
  const statusText = preview.mode === 'off' ? '预览已关闭'
    : preview.paused ? '后台已暂停'
    : preview.mode === 'snapshot' ? snapshot.error || (snapshot.image ? '画面快照 · 10s' : '正在获取快照')
    : preview.error || (showLivePreview ? '实时画面' : preview.isConnecting ? '正在连接' : '实时预览待连接')

  return {
    videoRef,
    fallbackSnapshot: snapshot.image,
    showLivePreview,
    isConnecting: preview.isConnecting,
    statusText,
    headerStatusText: showLivePreview ? `${preview.stats?.width || 0}×${preview.stats?.height || 0}` : statusText,
    retry: preview.connect,
    error: preview.mode === 'live' ? preview.error : snapshot.error,
  }
}
