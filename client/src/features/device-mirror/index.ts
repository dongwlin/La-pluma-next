/**
 * 投屏/截图预览域公开面
 */

import './styles/device-mirror.css'

export { getDeviceStats } from './api'
export { DEVICE_STATS_POLL_INTERVAL_MS } from './constants'
export { useDeviceStatsSample } from './hooks/useDeviceStatsSample'
export { deviceMirrorKeys } from './model/queryKeys'
export { deviceStatsQueryOptions } from './model/queries'
export type { DeviceMirrorResource } from './model/queryKeys'
export type { DeviceStatsPayload } from './model/queries'
export { PreviewModeSegmented } from './components/PreviewModeControls'
export { default as ScreenMonitor } from './components/ScreenMonitor'
export { usePreviewSession } from './hooks/usePreviewSession'
export { usePreviewSnapshot } from './hooks/usePreviewSnapshot'
export { usePreviewStore } from './store/previewStore'
export type { PreviewMode } from './store/previewStore'
