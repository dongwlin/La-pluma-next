import { useEffect, type RefObject } from 'react'
import { usePreviewSessionContext } from './previewSessionContext'

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>
}

/** Workspace views attach media; the provider alone owns connection lifetime. */
export function usePreviewSession({ videoRef }: Options) {
  const { session, activeVideoRef } = usePreviewSessionContext()
  const stream = session.mediaStream

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    activeVideoRef.current = video
    video.srcObject = stream
    if (stream) void video.play().catch(() => {})
    return () => {
      if (activeVideoRef.current === video) activeVideoRef.current = null
      video.srcObject = null
    }
  }, [activeVideoRef, stream, videoRef])

  return session
}
