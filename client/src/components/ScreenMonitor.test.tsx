// @vitest-environment jsdom

import { Activity, act, useEffect, useEffectEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScreenMonitor from './ScreenMonitor'
import { usePreviewStore } from '../stores/previewStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const availabilityMock = vi.hoisted(() => ({
  isAvailable: false,
  unavailableMessage: '正在检查后端服务，请稍候',
}))

const apiMocks = vi.hoisted(() => ({
  getWebrtcStatus: vi.fn(),
  startWebrtc: vi.fn(),
  installWebrtc: vi.fn(),
  startWebrtcServer: vi.fn(),
  stopWebrtcServer: vi.fn(),
  startWebrtcAgent: vi.fn(),
  stopWebrtcAgent: vi.fn(),
}))

const deviceViewBehavior = vi.hoisted(() => ({ startLiveOnMount: false }))

vi.mock('../hooks/useBackendStatusMonitor', () => ({
  useAutomationAvailability: () => availabilityMock,
}))

vi.mock('../services/api', () => ({
  maaApi: {
    ...apiMocks,
    getErrorMessage: (result?: { message?: string }) => result?.message || '预览操作失败',
  },
}))

interface MockDeviceViewProps {
  automationAvailable?: boolean
  automationUnavailableMessage?: string
  onStartInfrastructure?: (signal?: AbortSignal) => Promise<string | undefined> | string | undefined
  onCancelInfrastructure?: () => void
  onInstall?: () => Promise<void> | void
  onToggleServer?: () => Promise<void> | void
  onToggleAgent?: () => Promise<void> | void
  infrastructureStatus?: { serverRunning?: boolean; agentRunning?: boolean } | null
  infrastructureStatusState?: string
  infrastructureLoading?: string | null
  infrastructureError?: string | null
}

let latestDeviceViewProps: MockDeviceViewProps | null = null

vi.mock('./ScrcpyDeviceView', () => ({
  default: function MockDeviceView(props: MockDeviceViewProps) {
    const startInfrastructure = useEffectEvent(() => props.onStartInfrastructure?.())
    useEffect(() => { latestDeviceViewProps = props })
    useEffect(() => {
      if (deviceViewBehavior.startLiveOnMount && usePreviewStore.getState().mode === 'live') {
        void startInfrastructure()
      }
    }, [])
    return (
    <div
      data-available={String(props.automationAvailable)}
      data-message={props.automationUnavailableMessage}
      data-status-state={props.infrastructureStatusState}
      data-loading={props.infrastructureLoading || ''}
      data-error={props.infrastructureError || ''}
      data-has-status={String(Boolean(props.infrastructureStatus))}
      data-server-running={String(Boolean(props.infrastructureStatus?.serverRunning))}
      data-agent-running={String(Boolean(props.infrastructureStatus?.agentRunning))}
    >
      <button type="button" onClick={() => void props.onStartInfrastructure?.()}>start</button>
      <button type="button" onClick={() => void props.onInstall?.()}>install</button>
      <button type="button" onClick={() => void props.onToggleServer?.()}>server</button>
      <button type="button" onClick={() => void props.onToggleAgent?.()}>agent</button>
    </div>
    )
  },
}))

let container: HTMLDivElement
let root: Root

const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === label)
  await act(async () => button?.click())
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('ScreenMonitor automation availability guard', () => {
  beforeEach(() => {
    deviceViewBehavior.startLiveOnMount = false
    usePreviewStore.getState().setMode('off')
    availabilityMock.isAvailable = false
    availabilityMock.unavailableMessage = '正在检查后端服务，请稍候'
    apiMocks.getWebrtcStatus.mockResolvedValue({
      success: true,
      data: { installed: true, built: true, serverRunning: false, agentRunning: false },
    })
    apiMocks.startWebrtc.mockResolvedValue({ success: true, data: { signalingUrl: '/webrtc-signaling' } })
    apiMocks.installWebrtc.mockResolvedValue({ success: true })
    apiMocks.startWebrtcServer.mockResolvedValue({ success: true })
    apiMocks.stopWebrtcServer.mockResolvedValue({ success: true })
    apiMocks.startWebrtcAgent.mockResolvedValue({ success: true })
    apiMocks.stopWebrtcAgent.mockResolvedValue({ success: true })
    vi.clearAllMocks()
    latestDeviceViewProps = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it.each([
    ['checking', '正在检查后端服务，请稍候'],
    ['unavailable', '后端服务暂不可用，请确认服务已启动'],
  ])('blocks API side effects while backend is %s', async (_state, message) => {
    availabilityMock.unavailableMessage = message
    await act(async () => root.render(<ScreenMonitor />))
    await flush()

    expect(container.firstElementChild?.firstElementChild?.getAttribute('data-available')).toBe('false')
    expect(container.firstElementChild?.firstElementChild?.getAttribute('data-message')).toBe(message)

    await click('start')
    await click('install')
    await click('agent')
    await click('server')

    expect(apiMocks.startWebrtc).not.toHaveBeenCalled()
    expect(apiMocks.installWebrtc).not.toHaveBeenCalled()
    expect(apiMocks.startWebrtcServer).not.toHaveBeenCalled()
    expect(apiMocks.startWebrtcAgent).not.toHaveBeenCalled()
  })

  it('allows stop actions while unavailable so an existing preview can recover', async () => {
    apiMocks.getWebrtcStatus.mockResolvedValueOnce({
      success: true,
      data: { installed: true, built: true, serverRunning: true, agentRunning: true },
    }).mockResolvedValueOnce({
      success: true,
      data: { installed: true, built: true, serverRunning: true, agentRunning: false },
    })
    await act(async () => root.render(<ScreenMonitor />))
    await flush()

    await click('agent')
    await click('server')

    expect(apiMocks.stopWebrtcServer).toHaveBeenCalledOnce()
    expect(apiMocks.stopWebrtcAgent).toHaveBeenCalledOnce()
    expect(apiMocks.startWebrtcServer).not.toHaveBeenCalled()
    expect(apiMocks.startWebrtcAgent).not.toHaveBeenCalled()
  })

  it('reports an explicit error state instead of treating an unknown status as stopped', async () => {
    availabilityMock.isAvailable = true
    apiMocks.getWebrtcStatus.mockRejectedValueOnce(new Error('状态读取失败'))
    await act(async () => root.render(<ScreenMonitor />))
    await flush()

    const view = container.firstElementChild?.firstElementChild
    expect(view?.getAttribute('data-status-state')).toBe('error')
    expect(view?.getAttribute('data-has-status')).toBe('false')
    expect(view?.getAttribute('data-error')).toBe('状态读取失败')
  })

  it('serializes service operations so a second action cannot overtake the first', async () => {
    availabilityMock.isAvailable = true
    let resolveInstall: ((value: { success: boolean }) => void) | undefined
    apiMocks.installWebrtc.mockImplementationOnce(() => new Promise(resolve => {
      resolveInstall = resolve
    }))
    await act(async () => root.render(<ScreenMonitor />))
    await flush()

    await click('install')
    await click('server')

    expect(apiMocks.installWebrtc).toHaveBeenCalledOnce()
    expect(apiMocks.startWebrtcServer).not.toHaveBeenCalled()

    await act(async () => resolveInstall?.({ success: true }))
    await flush()
    await click('server')
    await flush()

    expect(apiMocks.startWebrtcServer).toHaveBeenCalledOnce()
  })

  it('does not start preview while another infrastructure action is pending', async () => {
    availabilityMock.isAvailable = true
    let resolveAgent: ((value: { success: boolean }) => void) | undefined
    apiMocks.startWebrtcAgent.mockImplementationOnce(() => new Promise(resolve => {
      resolveAgent = resolve
    }))
    apiMocks.getWebrtcStatus.mockResolvedValue({
      success: true,
      data: { installed: true, built: true, serverRunning: true, agentRunning: false },
    })
    await act(async () => root.render(<ScreenMonitor />))
    await flush()

    await click('agent')
    await click('start')

    expect(apiMocks.startWebrtcAgent).toHaveBeenCalledOnce()
    expect(apiMocks.startWebrtc).not.toHaveBeenCalled()

    await act(async () => resolveAgent?.({ success: true }))
    await flush()
  })

  it('ignores an initial status response that resolves after preview startup', async () => {
    availabilityMock.isAvailable = true
    let resolveInitial: ((value: { success: boolean; data: { serverRunning: boolean } }) => void) | undefined
    apiMocks.getWebrtcStatus.mockImplementationOnce(() => new Promise(resolve => {
      resolveInitial = resolve
    }))
    apiMocks.startWebrtc.mockResolvedValueOnce({
      success: true,
      data: { signalingUrl: '/webrtc-signaling', serverRunning: true, agentRunning: true },
    })

    await act(async () => root.render(<ScreenMonitor />))
    await click('start')
    await flush()
    expect(container.firstElementChild?.firstElementChild?.getAttribute('data-server-running')).toBe('true')

    await act(async () => resolveInitial?.({ success: true, data: { serverRunning: false } }))
    await flush()

    expect(container.firstElementChild?.firstElementChild?.getAttribute('data-server-running')).toBe('true')
  })

  it('does not read stopped status concurrently when an already-live child starts before its parent effect', async () => {
    availabilityMock.isAvailable = true
    deviceViewBehavior.startLiveOnMount = true
    usePreviewStore.getState().setMode('live')
    const pending = deferred<{
      success: boolean
      data: { signalingUrl: string; serverRunning: boolean; agentRunning: boolean }
    }>()
    apiMocks.startWebrtc.mockReturnValueOnce(pending.promise)

    await act(async () => root.render(<ScreenMonitor />))
    await flush()
    expect(apiMocks.startWebrtc).toHaveBeenCalledOnce()
    expect(apiMocks.getWebrtcStatus).not.toHaveBeenCalled()

    await act(async () => pending.resolve({
      success: true,
      data: { signalingUrl: '/webrtc-signaling', serverRunning: true, agentRunning: true },
    }))
    await flush()
    expect(latestDeviceViewProps?.infrastructureStatus).toMatchObject({ serverRunning: true, agentRunning: true })
    expect(latestDeviceViewProps?.infrastructureStatusState).toBe('ready')
    expect(apiMocks.getWebrtcStatus).not.toHaveBeenCalled()
  })

  it('clears pending preview startup across an Activity hide and ignores its hidden response', async () => {
    availabilityMock.isAvailable = true
    const pending = deferred<{ success: boolean; data: { signalingUrl: string; serverRunning: boolean } }>()
    apiMocks.startWebrtc.mockReturnValueOnce(pending.promise)
    await act(async () => root.render(<Activity mode="visible"><ScreenMonitor /></Activity>))
    await flush()
    let result: ReturnType<NonNullable<MockDeviceViewProps['onStartInfrastructure']>>
    act(() => { result = latestDeviceViewProps!.onStartInfrastructure!() })
    expect(latestDeviceViewProps!.infrastructureLoading).toBe('preview')

    await act(async () => root.render(<Activity mode="hidden"><ScreenMonitor /></Activity>))
    await act(async () => pending.resolve({
      success: true,
      data: { signalingUrl: 'ws://stale-hidden-start', serverRunning: true },
    }))
    expect(await result!).toBeUndefined()

    await act(async () => root.render(<Activity mode="visible"><ScreenMonitor /></Activity>))
    await flush()
    expect(latestDeviceViewProps!.infrastructureLoading).toBeNull()
    expect(latestDeviceViewProps!.infrastructureStatus?.serverRunning).toBe(false)
    expect(apiMocks.getWebrtcStatus).toHaveBeenCalledTimes(2)

    await click('start')
    await flush()
    expect(apiMocks.startWebrtc).toHaveBeenCalledTimes(2)
    expect(latestDeviceViewProps!.infrastructureLoading).toBeNull()
  })

  it('cancels startup immediately and prevents an old response from replacing a new preview', async () => {
    availabilityMock.isAvailable = true
    const pending = deferred<{ success: boolean; data: { signalingUrl: string; serverRunning: boolean } }>()
    apiMocks.startWebrtc.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      success: true,
      data: { signalingUrl: 'ws://new-preview', serverRunning: true },
    })
    await act(async () => root.render(<ScreenMonitor />))
    await flush()
    const controller = new AbortController()
    let cancelledResult: ReturnType<NonNullable<MockDeviceViewProps['onStartInfrastructure']>>
    act(() => { cancelledResult = latestDeviceViewProps!.onStartInfrastructure!(controller.signal) })
    expect(apiMocks.startWebrtc).toHaveBeenCalledWith('default', 'mumu-la-pluma', controller.signal)
    expect(latestDeviceViewProps!.infrastructureLoading).toBe('preview')

    act(() => latestDeviceViewProps!.onCancelInfrastructure!())
    expect(latestDeviceViewProps!.infrastructureLoading).toBeNull()
    let newResult: string | undefined
    await act(async () => { newResult = await latestDeviceViewProps!.onStartInfrastructure!() })
    expect(newResult!).toBe('ws://new-preview')

    await act(async () => pending.resolve({
      success: true,
      data: { signalingUrl: 'ws://cancelled-preview', serverRunning: false },
    }))
    expect(await cancelledResult!).toBeUndefined()
    expect(latestDeviceViewProps!.infrastructureStatus?.serverRunning).toBe(true)
    expect(latestDeviceViewProps!.infrastructureLoading).toBeNull()
    expect(latestDeviceViewProps!.infrastructureError).toBeNull()
  })

  it('refreshes the agent badge after live preview closes without starting infrastructure', async () => {
    vi.useFakeTimers()
    availabilityMock.isAvailable = true
    usePreviewStore.getState().setMode('live')
    apiMocks.getWebrtcStatus.mockResolvedValueOnce({
      success: true,
      data: { serverRunning: true, agentRunning: true },
    }).mockResolvedValue({
      success: true,
      data: { serverRunning: true, agentRunning: false },
    })
    await act(async () => root.render(<ScreenMonitor />))
    await flush()
    const view = container.firstElementChild?.firstElementChild
    expect(view?.getAttribute('data-agent-running')).toBe('true')
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    expect(apiMocks.getWebrtcStatus).toHaveBeenCalledOnce()

    act(() => usePreviewStore.getState().setMode('off'))
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    await flush()

    expect(apiMocks.getWebrtcStatus).toHaveBeenCalledTimes(2)
    expect(view?.getAttribute('data-agent-running')).toBe('false')
    expect(view?.getAttribute('data-server-running')).toBe('true')
    await act(async () => vi.advanceTimersByTimeAsync(18000))
    expect(apiMocks.getWebrtcStatus).toHaveBeenCalledTimes(2)
    expect(apiMocks.startWebrtc).not.toHaveBeenCalled()
    expect(apiMocks.startWebrtcServer).not.toHaveBeenCalled()
    expect(apiMocks.startWebrtcAgent).not.toHaveBeenCalled()
  })
})
