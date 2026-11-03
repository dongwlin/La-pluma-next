import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { getErrorMessage } from '@/shared/api'
import { startWebrtc } from '../api'
import { buildScrcpyOptions, usePreviewStore } from '../store/previewStore'
import { usePageVisible } from '@/shared/hooks/usePageVisible'
import { useScrcpyWebRTC } from './useScrcpyWebRTC'

type Options = Parameters<typeof useScrcpyWebRTC>[0] & {
  automationAvailable?: boolean
  infrastructureBusy?: boolean
  startInfrastructure?: (signal: AbortSignal) => Promise<string | undefined>
  cancelInfrastructure?: () => void
}

const CONNECTING_STATUSES = new Set(['connecting', 'signaling', 'waiting_offer', 'connecting_webrtc'])

/** The application owns one preview independently of workspace Activity effects. */
export function usePreviewSessionOwner({ automationAvailable = true, infrastructureBusy = false, startInfrastructure, cancelInfrastructure, ...options }: Options) {
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
      if (startInfrastructure) {
        signalingUrl = await startInfrastructure(signal)
      } else {
        const result = await startWebrtc('default', options.deviceId, signal)
        if (!result.success) throw new Error(getErrorMessage(result))
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
    cancelInfrastructure?.()
  })

  useEffect(() => {
    setStarting(false)
    setStartError(null)
    if (mode !== 'live' || !visible || !automationAvailable || infrastructureBusy) return
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
  }, [mode, visible, automationAvailable, infrastructureBusy, attempt, options.deviceId, options.signalingUrl, options.connectionPath, options.ipPreference])

  const connect = useCallback(() => {
    usePreviewStore.getState().setMode('live')
    setAttempt(value => value + 1)
  }, [])
  const disconnect = useCallback(() => {
    disconnectTransport()
    cancelInfrastructure?.()
    usePreviewStore.getState().setMode('off')
  }, [cancelInfrastructure, disconnectTransport])

  return {
    ...transport,
    connect,
    disconnect,
    mode,
    paused: !visible && mode !== 'off',
    starting,
    isConnecting: starting || (mode === 'live' && visible && automationAvailable && infrastructureBusy) || CONNECTING_STATUSES.has(transport.status),
    error: startError || transport.error,
  }
}
