import { useCallback, useEffect, useRef, useState } from 'react'
import { getErrorMessage, isAbortError } from '@/shared/api'
import {
  fetchAgentDiagnostics,
  type RuntimeDiagnosticsReport,
} from '../api/diagnostics'

export type RuntimeDiagnosticsLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RuntimeDiagnosticsState {
  status: RuntimeDiagnosticsLoadStatus
  report: RuntimeDiagnosticsReport | null
  error: string | null
  start: () => void
  reset: () => void
}

export function useRuntimeDiagnostics(command?: string): RuntimeDiagnosticsState {
  const [status, setStatus] = useState<RuntimeDiagnosticsLoadStatus>('idle')
  const [report, setReport] = useState<RuntimeDiagnosticsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const reportRef = useRef<RuntimeDiagnosticsReport | null>(null)

  const start = useCallback(() => {
    if (controllerRef.current) return

    const requestId = ++requestIdRef.current
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('loading')
    setError(null)

    void fetchAgentDiagnostics({ command, signal: controller.signal })
      .then(result => {
        if (requestId !== requestIdRef.current) return
        if (result.success && result.data) {
          reportRef.current = result.data
          setReport(result.data)
          setStatus('ready')
          return
        }
        setError(getErrorMessage(result))
        setStatus('error')
      })
      .catch((fetchError: unknown) => {
        if (requestId !== requestIdRef.current) return
        if (isAbortError(fetchError)) {
          setStatus(reportRef.current ? 'ready' : 'idle')
          return
        }
        setError(fetchError instanceof Error ? fetchError.message : '诊断请求失败')
        setStatus('error')
      })
      .finally(() => {
        if (requestId === requestIdRef.current) controllerRef.current = null
      })
  }, [command])

  const reset = useCallback(() => {
    requestIdRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    reportRef.current = null
    setReport(null)
    setError(null)
    setStatus('idle')
  }, [])

  useEffect(() => () => {
    const controller = controllerRef.current
    controllerRef.current = null
    if (!controller) return
    requestIdRef.current += 1
    controller.abort()
    setStatus(current => (
      current === 'loading' ? (reportRef.current ? 'ready' : 'idle') : current
    ))
  }, [])

  return { status, report, error, start, reset }
}
