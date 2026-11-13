import { createContext, useContext, type RefObject } from 'react'
import type { usePreviewSessionOwner } from './usePreviewSessionOwner'
import type { usePreviewSnapshotOwner } from './usePreviewSnapshotOwner'
import type { usePreviewInfrastructure } from './usePreviewInfrastructure'

interface PreviewSessionContextValue {
  session: ReturnType<typeof usePreviewSessionOwner>
  snapshot: ReturnType<typeof usePreviewSnapshotOwner>
  activeVideoRef: RefObject<HTMLVideoElement | null>
  infrastructure: ReturnType<typeof usePreviewInfrastructure>
}

export const PreviewSessionContext = createContext<PreviewSessionContextValue | null>(null)

export function usePreviewSessionContext() {
  const context = useContext(PreviewSessionContext)
  if (!context) throw new Error('Preview views must be rendered inside PreviewSessionProvider')
  return context
}
