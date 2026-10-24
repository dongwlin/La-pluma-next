/**
 * 投屏/截图预览域公开面
 */

export { PreviewModeSegmented } from './components/PreviewModeControls'
export { default as ScreenMonitor } from './components/ScreenMonitor'
export { usePreviewSession } from './hooks/usePreviewSession'
export { usePreviewSnapshot } from './hooks/usePreviewSnapshot'
export { usePreviewStore } from './store/previewStore'
export type { PreviewMode } from './store/previewStore'
