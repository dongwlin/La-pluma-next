import { useRef, type ReactNode } from 'react'
import { useAutomationAvailability } from '@/features/runtime-status'
import { PreviewSessionContext } from '../hooks/previewSessionContext'
import { usePreviewSessionOwner } from '../hooks/usePreviewSessionOwner'
import { usePreviewSnapshotOwner } from '../hooks/usePreviewSnapshotOwner'
import { usePreviewInfrastructure } from '../hooks/usePreviewInfrastructure'

/** Keeps media and snapshot sampling alive while workspace views change. */
export function PreviewSessionProvider({ children }: { children: ReactNode }) {
  const { isAvailable } = useAutomationAvailability()
  const activeVideoRef = useRef<HTMLVideoElement | null>(null)
  const infrastructure = usePreviewInfrastructure()
  const session = usePreviewSessionOwner({
    videoRef: activeVideoRef,
    deviceId: 'mumu-la-pluma',
    signalingUrl: '/webrtc-signaling',
    automationAvailable: isAvailable,
    infrastructureBusy: infrastructure.view.infrastructureLoading !== null && infrastructure.view.infrastructureLoading !== 'preview',
    connectionPath: 'auto',
    ipPreference: 'ipv4',
    startInfrastructure: infrastructure.start,
    cancelInfrastructure: infrastructure.cancel,
  })
  const snapshot = usePreviewSnapshotOwner(isAvailable)

  return (
    <PreviewSessionContext value={{ session, snapshot, activeVideoRef, infrastructure }}>
      {children}
    </PreviewSessionContext>
  )
}
