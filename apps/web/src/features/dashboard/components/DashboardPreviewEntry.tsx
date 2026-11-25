import { memo } from 'react'
import { Smartphone } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { useDashboardPreview } from '../hooks/useDashboardPreview'
import { useRetainedSnapshot } from '../hooks/useRetainedSnapshot'
import { PreviewModeSegmented } from '@/features/device-mirror'

const DashboardPreviewEntry = memo(function DashboardPreviewEntry() {
  const { videoRef, fallbackSnapshot, isConnecting, status, retry, available = true } = useDashboardPreview()
  const retainedSnapshot = useRetainedSnapshot(fallbackSnapshot, Boolean(fallbackSnapshot))
  const liveVisible = status.phase === 'live-connected'
  const hasFrame = status.hasFrame

  return (
    <Card
      data-dashboard-preview-card
      className={`status-border-beam gap-0 p-0! ${isConnecting ? 'is-active' : ''}`}
      aria-busy={isConnecting}
    >
      <div className="dashboard-preview-header flex items-center justify-between gap-3.5 px-4 py-2 border-b border-border">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`preview-status-light is-${status.tone}`}
            data-preview-status={status.phase}
            aria-hidden="true"
          />
          <span className="truncate text-xs font-medium text-muted-foreground">画面预览</span>
          <span
            className="truncate text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {status.label}
          </span>
        </div>
        <PreviewModeSegmented unavailable={!available} />
      </div>
      {status.error && hasFrame && (
        <div role="alert" className="status-warning flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs leading-5">
          <span className="min-w-0 flex-1">
            <span className="font-medium">{status.error.title}</span>
            <span className="ml-1 text-muted-foreground">{status.error.message}</span>
          </span>
          {status.retry && (
            <Button onClick={retry} variant="secondary" size="sm">
              {status.retry.label}
            </Button>
          )}
        </div>
      )}
      <div
        data-dashboard-preview-frame
        className={`dashboard-preview-frame relative aspect-video w-full overflow-hidden transition-colors duration-200 ${hasFrame ? 'bg-black' : 'is-empty'}`}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-hidden="true"
          className={`relative h-full w-full bg-black object-contain transition-opacity duration-200 ${liveVisible ? 'opacity-100' : 'opacity-0'}`}
        />
        {retainedSnapshot.snapshot && (
          <img
            src={retainedSnapshot.snapshot}
            alt="模拟器画面快照"
            draggable={false}
            aria-hidden={!retainedSnapshot.visible}
            className={`dashboard-preview-snapshot-image absolute inset-0 h-full w-full select-none object-contain pointer-events-none transition-opacity duration-200 ${retainedSnapshot.visible ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {status.snapshotStale && retainedSnapshot.visible && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/70 px-2 py-1 text-xs text-white/90">
            上次成功画面 · 可能已过期
          </span>
        )}
        <div
          className={`dashboard-preview-empty absolute inset-0 flex items-center justify-center px-4 text-center transition-opacity duration-200 ${hasFrame ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
          role={status.error ? 'alert' : undefined}
          aria-hidden={hasFrame}
        >
          <div>
            <div className="device-preview-empty-icon mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg">
              <Smartphone className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
            </div>
            <div className="text-sm font-semibold text-foreground">{status.emptyTitle}</div>
            {status.error && (
              <div className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">{status.error.message}</div>
            )}
            <div className="mt-3 flex h-7 items-center justify-center">
              {status.retry && (
                <Button onClick={retry} variant="secondary" size="sm">
                  {status.retry.label}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
})

export default DashboardPreviewEntry
