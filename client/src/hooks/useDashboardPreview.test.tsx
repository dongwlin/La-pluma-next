// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboardPreview } from './useDashboardPreview'
import { usePreviewStore } from '../stores/previewStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getWebrtcStatus: vi.fn(),
  startWebrtc: vi.fn(),
  captureScreen: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('./useBackendStatusMonitor', () => ({ useAutomationAvailability: () => ({ isAvailable: true }) }))

vi.mock('@/shared/api', () => ({
  maaApi: {
    getWebrtcStatus: mocks.getWebrtcStatus,
    startWebrtc: mocks.startWebrtc,
    getErrorMessage: () => '预览失败',
    captureScreen: mocks.captureScreen,
  },
}))

vi.mock('./useScrcpyWebRTC', () => ({
  useScrcpyWebRTC: () => ({
    status: 'idle',
    error: null,
    stats: null,
    inputReady: false,
    mediaStream: null,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    sendTouch: vi.fn(),
    sendCommand: vi.fn(),
  }),
}))

function PreviewHarness() {
  const { videoRef, statusText, connectionState } = useDashboardPreview()
  return <video ref={videoRef} data-preview-status={statusText} data-preview-connection={connectionState} />
}

describe('useDashboardPreview Activity lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewStore.setState({ mode: 'off', autoStart: false })
    mocks.startWebrtc.mockReset().mockResolvedValue({ success: true, data: { signalingUrl: '/webrtc-signaling' } })
    mocks.getWebrtcStatus.mockReset().mockResolvedValue({
      success: true,
      data: { serverRunning: true, agentRunning: true, signalingUrl: '/webrtc-signaling' },
    })
    mocks.captureScreen.mockReset().mockResolvedValue({ success: false })
    mocks.connect.mockReset()
    mocks.disconnect.mockReset()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const renderMode = async (mode: 'visible' | 'hidden') => {
    await act(async () => {
      root.render(
        <Activity mode={mode}>
          <PreviewHarness />
        </Activity>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('resumes only the explicitly selected live mode when the dashboard returns', async () => {
    usePreviewStore.getState().setMode('live')
    await renderMode('visible')
    expect(mocks.connect).toHaveBeenCalledOnce()

    await renderMode('hidden')
    await renderMode('visible')

    expect(mocks.connect).toHaveBeenCalledTimes(2)
  })
  it('does not connect or capture a screenshot merely because the service is online', async () => {
    await renderMode('visible')
    expect(mocks.startWebrtc).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.captureScreen).not.toHaveBeenCalled()
    expect(container.querySelector('video')?.dataset.previewStatus).toBe('预览已关闭')
    expect(container.querySelector('video')?.dataset.previewConnection).toBe('off')
  })

  it('reports a connecting state while the first snapshot is pending', async () => {
    mocks.captureScreen.mockReturnValue(new Promise(() => {}))
    usePreviewStore.getState().setMode('snapshot')
    await renderMode('visible')

    expect(container.querySelector('video')?.dataset.previewConnection).toBe('connecting')
  })

  it('stays off after the user closes preview and changes workspaces', async () => {
    usePreviewStore.getState().setMode('live')
    await renderMode('visible')
    await act(async () => usePreviewStore.getState().setMode('off'))
    await renderMode('hidden')
    await renderMode('visible')
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.captureScreen).not.toHaveBeenCalled()
  })

})
