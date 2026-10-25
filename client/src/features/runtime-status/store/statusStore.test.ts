import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStatusStore } from './statusStore'
import type { GlobalRunStatus } from '@/features/task-execution'

const IDLE: GlobalRunStatus = { phase: 'idle', isRunning: false, runId: null, label: null, detail: null }
const RUNNING: GlobalRunStatus = {
  phase: 'running',
  isRunning: true,
  runId: 'run-1',
  label: '正在执行: 收取信用',
  detail: '今日流程执行中',
}
const OCCUPIED: GlobalRunStatus = {
  phase: 'occupied',
  isRunning: false,
  runId: null,
  label: '设备被其他任务占用',
  detail: null,
}

describe('statusStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStatusStore.getState().clearMessage()
    useStatusStore.getState().applyRunStatus(IDLE)
    useStatusStore.getState().setBackendStatus('unknown')
  })

  afterEach(() => {
    useStatusStore.getState().clearMessage()
    useStatusStore.getState().applyRunStatus(IDLE)
    useStatusStore.getState().setBackendStatus('unknown')
    vi.useRealTimers()
  })

  it('does not let an older dismissal clear a newer message', () => {
    useStatusStore.getState().setMessage('配置已保存', 'success')
    vi.advanceTimersByTime(1000)

    useStatusStore.getState().setMessage('正在执行任务', 'info')
    vi.advanceTimersByTime(600)

    expect(useStatusStore.getState().message).toBe('正在执行任务')
  })

  it('keeps errors visible until the user dismisses them', () => {
    useStatusStore.getState().setMessage('连接失败', 'error')
    vi.advanceTimersByTime(60000)

    expect(useStatusStore.getState().message).toBe('连接失败')
    useStatusStore.getState().clearMessage()
    expect(useStatusStore.getState().message).toBe('')
  })

  it('ignores legacy delayed empty-message clears', () => {
    useStatusStore.getState().setMessage('旧提示', 'success')
    useStatusStore.getState().setMessage('新提示', 'error')
    useStatusStore.getState().setMessage('')

    expect(useStatusStore.getState().message).toBe('新提示')
  })

  it('keeps active messages until the projected run leaves the device busy', () => {
    useStatusStore.getState().applyRunStatus(RUNNING)
    useStatusStore.getState().setMessage('正在执行任务', 'info')
    vi.advanceTimersByTime(20000)

    expect(useStatusStore.getState().message).toBe('正在执行任务')
    expect(useStatusStore.getState().runStatus).toEqual(RUNNING)

    useStatusStore.getState().applyRunStatus(IDLE)
    vi.advanceTimersByTime(10000)
    expect(useStatusStore.getState().message).toBe('')
  })

  it('treats external occupancy as busy without claiming a run', () => {
    useStatusStore.getState().applyRunStatus(OCCUPIED)
    useStatusStore.getState().setMessage('正在检查更新', 'info')
    vi.advanceTimersByTime(20000)

    expect(useStatusStore.getState().message).toBe('正在检查更新')
    expect(useStatusStore.getState().runStatus.phase).toBe('occupied')
  })

  it('does not postpone dismissal when an idle projection is reported repeatedly', () => {
    useStatusStore.getState().setMessage('配置已保存', 'success')
    vi.advanceTimersByTime(1000)
    useStatusStore.getState().applyRunStatus(IDLE)
    vi.advanceTimersByTime(500)

    expect(useStatusStore.getState().message).toBe('')
  })

  it('ignores a projection identical to the current one', () => {
    useStatusStore.getState().applyRunStatus(RUNNING)
    const subscriber = vi.fn()
    const unsubscribe = useStatusStore.subscribe(subscriber)
    useStatusStore.getState().applyRunStatus({ ...RUNNING })

    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps backend availability separate from temporary messages', () => {
    useStatusStore.getState().setBackendStatus('unavailable', '无法连接后端服务')
    useStatusStore.getState().setMessage('正在刷新', 'info')

    vi.advanceTimersByTime(20000)

    expect(useStatusStore.getState().message).toBe('')
    expect(useStatusStore.getState().backendStatus).toBe('unavailable')
    expect(useStatusStore.getState().backendMessage).toBe('无法连接后端服务')

    useStatusStore.getState().setBackendStatus('available')
    expect(useStatusStore.getState().backendMessage).toBe('')
  })
})
