// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import { HistoryLogSession } from './historyLogSession'
import type { LogFile } from '../types'

const file = (name: string): LogFile => ({
  name,
  path: `/logs/${name}`,
  size: 1024,
  modified: '2026-10-25T10:00:00.000Z',
})

const listOk = (files: LogFile[]): ApiResponse<unknown> => ({ success: true, data: files })

const contentOk = (content: string): ApiResponse<unknown> => ({
  success: true,
  data: { content },
})

const historyLine = (message: string) => `[2026-10-25 10:00:00][INFO] ${message}`

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('HistoryLogSession', () => {
  it('loads the file list on start and keeps the last successful list when a reload fails', async () => {
    const first = file('first.log')
    const second = file('second.log')
    const listFiles = vi.fn<(signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce(listOk([first, second]))
      .mockResolvedValueOnce({ success: false, message: '历史列表暂不可用' })
    const session = new HistoryLogSession({ listFiles })

    session.start()
    await flush()

    expect(session.getState()).toMatchObject({
      files: [first, second],
      filesPhase: 'ready',
      filesError: null,
    })

    const outcome = await session.reloadFiles()

    expect(outcome).toBe('failed')
    expect(session.getState().files).toEqual([first, second])
    expect(session.getState().filesPhase).toBe('failed')
    expect(session.getState().filesError).toBe('历史列表暂不可用')
  })

  it('ignores a stale file-list response that resolves after a newer request', async () => {
    const first = file('first.log')
    const second = file('second.log')
    const older = deferred<ApiResponse<unknown>>()
    const newer = deferred<ApiResponse<unknown>>()
    const listFiles = vi.fn<(signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const session = new HistoryLogSession({ listFiles })

    session.start()
    const olderSignal = listFiles.mock.calls[0]?.[0]
    const reload = session.reloadFiles()
    expect(olderSignal?.aborted).toBe(true)

    newer.resolve(listOk([second]))
    await reload
    expect(session.getState().files).toEqual([second])

    older.resolve(listOk([first]))
    await flush()
    expect(session.getState().files).toEqual([second])
    expect(session.getState().filesPhase).toBe('ready')
  })

  it('aborts the previous read when another file is selected and only keeps the latest content', async () => {
    const first = file('first.log')
    const second = file('second.log')
    const older = deferred<ApiResponse<unknown>>()
    const newer = deferred<ApiResponse<unknown>>()
    const readFile = vi.fn<(
      path: string,
      lines?: number,
      signal?: AbortSignal,
    ) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([first, second])),
      readFile,
    })

    session.start()
    await flush()
    session.selectFile(first)
    const olderSignal = readFile.mock.calls[0]?.[2]
    session.selectFile(second)
    expect(olderSignal?.aborted).toBe(true)

    newer.resolve(contentOk(historyLine('第二个文件')))
    await flush()
    expect(session.getState().selectedFile).toEqual(second)
    expect(session.getState().logs.map(log => log.message)).toEqual(['第二个文件'])
    expect(session.getState().readPhase).toBe('ready')

    older.resolve(contentOk(historyLine('旧文件')))
    await flush()
    expect(session.getState().selectedFile).toEqual(second)
    expect(session.getState().logs.map(log => log.message)).toEqual(['第二个文件'])
  })

  it('discards an in-flight history read after returning to realtime', async () => {
    const target = file('maa.log')
    const pending = deferred<ApiResponse<unknown>>()
    const readFile = vi.fn<(
      path: string,
      lines?: number,
      signal?: AbortSignal,
    ) => Promise<ApiResponse<unknown>>>().mockReturnValue(pending.promise)
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([target])),
      readFile,
    })

    session.start()
    await flush()
    session.selectFile(target)
    const signal = readFile.mock.calls[0]?.[2]

    session.backToRealtime()
    expect(signal?.aborted).toBe(true)
    expect(session.getState()).toMatchObject({
      viewing: false,
      selectedFile: null,
      logs: [],
      readPhase: 'idle',
      error: null,
    })

    pending.resolve(contentOk(historyLine('迟到内容')))
    await flush()
    expect(session.getState().logs).toEqual([])
    expect(session.getState().viewing).toBe(false)
  })

  it('cancels a read on Activity hide and retries it when the page is shown again', async () => {
    const target = file('maa.log')
    const beforeHide = deferred<ApiResponse<unknown>>()
    const afterRestore = deferred<ApiResponse<unknown>>()
    const readFile = vi.fn<(
      path: string,
      lines?: number,
      signal?: AbortSignal,
    ) => Promise<ApiResponse<unknown>>>()
      .mockReturnValueOnce(beforeHide.promise)
      .mockReturnValueOnce(afterRestore.promise)
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([target])),
      readFile,
    })

    session.start()
    await flush()
    session.selectFile(target)
    const hiddenSignal = readFile.mock.calls[0]?.[2]
    expect(session.getState().readPhase).toBe('loading')

    session.stop()
    expect(hiddenSignal?.aborted).toBe(true)
    expect(session.getState()).toMatchObject({
      viewing: true,
      selectedFile: target,
      readPhase: 'cancelled',
      error: null,
    })

    session.start()
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(session.getState().readPhase).toBe('loading')

    beforeHide.resolve(contentOk(historyLine('隐藏期间返回')))
    await flush()
    expect(session.getState().logs).toEqual([])

    afterRestore.resolve(contentOk(historyLine('恢复后读取')))
    await flush()
    expect(session.getState().readPhase).toBe('ready')
    expect(session.getState().logs.map(log => log.message)).toEqual(['恢复后读取'])
  })

  it('does not retry a completed or failed read on restore', async () => {
    const successFile = file('success.log')
    const failedFile = file('failed.log')
    const readFile = vi.fn<(
      path: string,
      lines?: number,
      signal?: AbortSignal,
    ) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce(contentOk(historyLine('已完成')))
      .mockResolvedValueOnce({ success: false, message: '读取失败' })
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([successFile, failedFile])),
      readFile,
    })

    session.start()
    await flush()
    session.selectFile(successFile)
    await flush()
    expect(session.getState().readPhase).toBe('ready')

    session.stop()
    session.start()
    await flush()
    expect(readFile).toHaveBeenCalledTimes(1)

    session.selectFile(failedFile)
    await flush()
    expect(session.getState()).toMatchObject({
      readPhase: 'failed',
      error: '读取失败',
    })

    session.stop()
    session.start()
    await flush()
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(session.getState().error).toBe('读取失败')
  })

  it('keeps the selected file on a failed read and replaces the error on retry', async () => {
    const target = file('maa.log')
    const readFile = vi.fn<(
      path: string,
      lines?: number,
      signal?: AbortSignal,
    ) => Promise<ApiResponse<unknown>>>()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(contentOk(historyLine('重试成功')))
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([target])),
      readFile,
    })

    session.start()
    await flush()
    session.selectFile(target)
    await flush()
    expect(session.getState()).toMatchObject({
      viewing: true,
      selectedFile: target,
      readPhase: 'failed',
      error: '网络中断',
      logs: [],
    })

    session.retry()
    await flush()
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(session.getState().readPhase).toBe('ready')
    expect(session.getState().error).toBeNull()
    expect(session.getState().logs.map(log => log.message)).toEqual(['重试成功'])
  })

  it('drops a selected file that no longer exists after cleanup reconciliation', async () => {
    const removed = file('removed.log')
    const kept = file('kept.log')
    const listFiles = vi.fn<(signal?: AbortSignal) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce(listOk([removed, kept]))
      .mockResolvedValueOnce(listOk([kept]))
    const session = new HistoryLogSession({
      listFiles,
      readFile: vi.fn().mockResolvedValue(contentOk(historyLine('旧内容'))),
    })

    session.start()
    await flush()
    session.selectFile(removed)
    await flush()

    await session.reloadFiles()
    expect(session.getState().selectedFile).toEqual(removed)
    expect(session.getState().files).toEqual([kept])

    expect(session.reconcileSelection()).toBe(true)
    expect(session.getState()).toMatchObject({
      viewing: false,
      selectedFile: null,
      logs: [],
      readPhase: 'idle',
    })
  })

  it('keeps the selection when the file still exists after cleanup reconciliation', async () => {
    const target = file('maa.log')
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockResolvedValue(listOk([target])),
      readFile: vi.fn().mockResolvedValue(contentOk(historyLine('保留'))),
    })

    session.start()
    await flush()
    session.selectFile(target)
    await flush()

    expect(session.reconcileSelection()).toBe(false)
    expect(session.getState()).toMatchObject({
      viewing: true,
      selectedFile: target,
    })
  })

  it('drops an in-flight list request on stop and does not leave the list loading', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const session = new HistoryLogSession({
      listFiles: vi.fn().mockReturnValue(pending.promise),
    })

    session.start()
    expect(session.getState().filesPhase).toBe('loading')

    session.stop()
    expect(session.getState().filesPhase).toBe('idle')

    pending.resolve(listOk([file('late.log')]))
    await flush()
    expect(session.getState().files).toEqual([])
    expect(session.getState().filesPhase).toBe('idle')
  })
})
