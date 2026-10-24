import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { maaApi } from '@/shared/api'
import { buildScrcpyOptions, usePreviewStore } from '../stores/previewStore'
import { usePageVisible } from '@/shared/hooks/usePageVisible'
import { useScrcpyWebRTC } from './useScrcpyWebRTC'

type Options = Parameters<typeof useScrcpyWebRTC>[0] & {
  automationAvailable?: boolean
  onStartInfrastructure?: (signal?: AbortSignal) => Promise<string | undefined> | string | undefined
  onCancelInfrastructure?: () => void
}

const CONNECTING_STATUSES = new Set(['connecting', 'signaling', 'waiting_offer', 'connecting_webrtc'])

/** A visible workspace watches only the mode explicitly selected by the user. */
export function usePreviewSession({ automationAvailable = true, onStartInfrastructure, onCancelInfrastructure, ...options }: Options) {
  const mode = usePreviewStore(state => state.mode)
  const quality = usePreviewStore(state => state.quality)
  const fps = usePreviewStore(state => state.fps)
  const maxSize = usePreviewStore(state => state.maxSize)
  const bitrateMbps = usePreviewStore(state => state.bitrateMbps)
  const visible = usePageVisible()
  const [attempt, setAttempt] = useState(0)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const scrcpyOptions = useMemo(() => buildScrcpyOptions({ quality, fps, maxSize, bitrateMbps }), [quality, fps, maxSize, bitrateMbps])
  const transport = useScrcpyWebRTC({ ...options, scrcpyOptions })
  const disconnectTransport = transport.disconnect

  const start = useEffectEvent(async (signal: AbortSignal) => {
    setStarting(true)
    setStartError(null)
    try {
      let signalingUrl: string | undefined
      if (onStartInfrastructure) {
        signalingUrl = await onStartInfrastructure(signal)
      } else {
        const result = await maaApi.startWebrtc('default', options.deviceId, signal)
        if (!result.success) throw new Error(maaApi.getErrorMessage(result))
        signalingUrl = result.data?.signalingUrl
      }
      if (signal.aborted) return
      if (!signalingUrl) throw new Error('预览服务未就绪，请重试')
      transport.connect(signalingUrl)
    } catch (error) {
      if (!signal.aborted) setStartError(error instanceof Error ? error.message : '无法启动实时预览')
    } finally {
      if (!signal.aborted) setStarting(false)
    }
  })
  const release = useEffectEvent(() => {
    transport.disconnect()
    onCancelInfrastructure?.()
  })

  useEffect(() => {
    setStarting(false)
    setStartError(null)
    if (mode !== 'live' || !visible || !automationAvailable) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      controller.abort()
      setStarting(false)
      setStartError('预览服务启动超时，请重试或关闭预览')
      release()
    }, 45000)
    void start(controller.signal).finally(() => clearTimeout(timeout))
    return () => {
      controller.abort()
      clearTimeout(timeout)
      release()
    }
  }, [mode, visible, automationAvailable, attempt, options.deviceId, options.signalingUrl, options.connectionPath, options.ipPreference])

  const connect = useCallback(() => {
    usePreviewStore.getState().setMode('live')
    setAttempt(value => value + 1)
  }, [])
  const disconnect = useCallback(() => {
    disconnectTransport()
    onCancelInfrastructure?.()
    usePreviewStore.getState().setMode('off')
  }, [disconnectTransport, onCancelInfrastructure])

  return {
    ...transport,
    connect,
    disconnect,
    mode,
    paused: !visible && mode !== 'off',
    starting,
    isConnecting: starting || CONNECTING_STATUSES.has(transport.status),
    error: startError || transport.error,
  }
}
