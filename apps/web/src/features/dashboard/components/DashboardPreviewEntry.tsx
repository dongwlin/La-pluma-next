import { memo } from 'react'
import { Smartphone } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/components'
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
        <Alert variant="destructive" className="mx-4 mt-3">
          <AlertTitle>{status.error.title}</AlertTitle>
          <AlertDescription>{status.error.message}</AlertDescription>
          {status.retry && (
            <div className="mt-1.5">
              <Button onClick={retry} variant="secondary" size="sm" className="min-h-11">
                {status.retry.label}
              </Button>
            </div>
          )}
        </Alert>
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
          <Badge variant="secondary" className="absolute left-2 top-2 border-white/20 bg-black/70 text-white">
            上次成功画面 · 可能已过期
          </Badge>
        )}
        <EmptyState
          compact
          role={status.error ? 'alert' : undefined}
          aria-hidden={hasFrame}
          icon={<Smartphone className="size-5" strokeWidth={1.6} />}
          title={status.emptyTitle}
          description={status.error?.message}
          action={status.retry ? (
            <Button onClick={retry} variant="secondary" size="sm" className="min-h-11">
              {status.retry.label}
            </Button>
          ) : undefined}
          className={`dashboard-preview-empty absolute inset-0 px-4 transition-opacity duration-200 ${hasFrame ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
        />
      </div>
    </Card>
  )
})

export default DashboardPreviewEntry
