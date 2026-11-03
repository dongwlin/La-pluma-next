// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import type { HistoryFilesOutcome } from './historyLogSession'
import {
  cleanupHistoryLogsCommand,
  LOG_CLEANUP_MAX_SIZE_MB,
} from './logCommands'

const createHistoryPort = (outcome: HistoryFilesOutcome = 'ready') => {
  const calls: string[] = []
  return {
    calls,
    reloadFiles: vi.fn(async () => {
      calls.push('reload')
      return outcome
    }),
    reconcileSelection: vi.fn(() => {
      calls.push('reconcile')
      return false
    }),
  }
}

describe('cleanupHistoryLogsCommand', () => {
  it('refreshes the file list and reconciles the selection after cleanup', async () => {
    const history = createHistoryPort('ready')
    const request = vi.fn().mockResolvedValue({ success: true, message: '已清理 2 个日志文件' })

    const outcome = await cleanupHistoryLogsCommand(history, request)

    expect(request).toHaveBeenCalledWith(LOG_CLEANUP_MAX_SIZE_MB, undefined)
    expect(history.calls).toEqual(['reload', 'reconcile'])
    expect(outcome).toEqual({ status: 'succeeded', message: '已清理 2 个日志文件' })
  })

  it('does not reload or touch the selection when cleanup fails', async () => {
    const history = createHistoryPort('ready')
    const request = vi.fn().mockResolvedValue({ success: false, message: '清理失败' })

    const outcome = await cleanupHistoryLogsCommand(history, request)

    expect(outcome).toEqual({ status: 'failed', message: '清理失败' })
    expect(history.reloadFiles).not.toHaveBeenCalled()
    expect(history.reconcileSelection).not.toHaveBeenCalled()
  })

  it('does not reconcile when the refreshed list is unavailable', async () => {
    const history = createHistoryPort('failed')
    const request = vi.fn().mockResolvedValue({ success: true, message: '清理完成' })

    const outcome = await cleanupHistoryLogsCommand(history, request)

    expect(outcome).toEqual({ status: 'succeeded', message: '清理完成' })
    expect(history.reloadFiles).toHaveBeenCalledTimes(1)
    expect(history.reconcileSelection).not.toHaveBeenCalled()
  })

  it('does not reconcile when the refreshed list request is cancelled', async () => {
    const history = createHistoryPort('cancelled')
    const request = vi.fn().mockResolvedValue({ success: true })

    const outcome = await cleanupHistoryLogsCommand(history, request)

    expect(outcome).toEqual({ status: 'succeeded', message: '历史日志清理完成' })
    expect(history.reconcileSelection).not.toHaveBeenCalled()
  })

  it('reports a thrown cleanup request without refreshing the list', async () => {
    const history = createHistoryPort('ready')
    const request = vi.fn<(maxSizeMB: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockRejectedValue(new Error('清理接口不可用'))

    const outcome = await cleanupHistoryLogsCommand(history, request)

    expect(outcome).toEqual({ status: 'failed', message: '清理接口不可用' })
    expect(history.reloadFiles).not.toHaveBeenCalled()
  })

  it('reports a cancelled cleanup wait without refreshing the list', async () => {
    const history = createHistoryPort('ready')
    const controller = new AbortController()
    const request = vi.fn<(maxSizeMB: number, signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const outcome = await cleanupHistoryLogsCommand(history, request, controller.signal)

    expect(request).toHaveBeenCalledWith(LOG_CLEANUP_MAX_SIZE_MB, controller.signal)
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(history.reloadFiles).not.toHaveBeenCalled()
  })

  it('does not start cleanup for an already aborted signal', async () => {
    const history = createHistoryPort('ready')
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn()

    const outcome = await cleanupHistoryLogsCommand(history, request, controller.signal)

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(request).not.toHaveBeenCalled()
    expect(history.reloadFiles).not.toHaveBeenCalled()
  })
})
