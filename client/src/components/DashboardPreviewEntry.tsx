import { memo } from 'react'
import { Monitor } from 'lucide-react'
import { Button, SmoothPanel } from '@/shared/ui'
import { useDashboardPreview } from '../hooks/useDashboardPreview'
import { PreviewModeSegmented } from './PreviewModeControls'

interface DashboardPreviewEntryProps {
  onOpen: () => void
}

const DashboardPreviewEntry = memo(function DashboardPreviewEntry({ onOpen }: DashboardPreviewEntryProps) {
  const { videoRef, fallbackSnapshot, showLivePreview, isConnecting, connectionState, statusText, error, retry, available = true } = useDashboardPreview()

  return (
    <SmoothPanel
      data-dashboard-preview-card
      className={`status-border-beam ${isConnecting ? 'is-active' : ''}`}
      aria-busy={isConnecting}
    >
      <div className="dashboard-preview-header flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--app-border)]">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`preview-status-light is-${connectionState}`}
            data-preview-status={connectionState}
            role="img"
            aria-label={statusText}
            title={statusText}
          />
          <span className="truncate text-xs font-medium text-secondary">模拟器预览</span>
        </div>
        <PreviewModeSegmented unavailable={!available} />
      </div>
      <div
        data-dashboard-preview-frame
        className={`dashboard-preview-frame relative aspect-video w-full overflow-hidden ${showLivePreview || fallbackSnapshot ? 'bg-black' : 'is-empty'}`}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-hidden="true"
          className={`relative h-full w-full bg-black object-contain ${showLivePreview ? 'opacity-100' : 'opacity-0'}`}
        />
        {!showLivePreview && fallbackSnapshot && (
          <img
            src={fallbackSnapshot}
            alt="模拟器画面快照"
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-contain pointer-events-none"
          />
        )}
        <button
          type="button"
          onClick={onOpen}
          aria-label={showLivePreview ? '打开模拟器实时预览' : fallbackSnapshot ? '打开模拟器画面快照' : '打开完整模拟器控制台'}
          className={`absolute inset-0 flex items-center justify-center text-left ${showLivePreview || fallbackSnapshot ? 'bg-transparent' : 'dashboard-preview-empty'}`}
        >
          {!showLivePreview && !fallbackSnapshot && (
            <div className="relative text-center">
              <div className="device-preview-empty-icon mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg">
                <Monitor size={17} strokeWidth={2} />
              </div>
              <div className="text-sm font-semibold text-primary">{statusText}</div>
              <div className="mt-1 text-xs text-secondary">点击进入完整控制台</div>
            </div>
          )}
        </button>
        {error && (
          <Button onClick={retry} variant="secondary" size="sm" className="absolute bottom-2 right-2">
            重试实时预览
          </Button>
        )}
      </div>
    </SmoothPanel>
  )
})

export default DashboardPreviewEntry
