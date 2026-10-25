// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import {
  SETTINGS_UPDATE_RESOURCE_SCOPES,
  SettingsUpdateOwner,
  coreChannelLabel,
  readUpdateFailureDetails,
  resolveCoreChannelSwitch,
  shouldRetryUpdateResources,
} from './updateCommands'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

interface OwnerMocks {
  updateCore: ReturnType<typeof vi.fn<(version?: string) => Promise<ApiResponse>>>
  updateCli: ReturnType<typeof vi.fn<() => Promise<ApiResponse>>>
  updateResources: ReturnType<typeof vi.fn<() => Promise<ApiResponse>>>
}

const createOwner = (
  responses: Partial<Record<keyof OwnerMocks, Promise<ApiResponse>>> = {},
): { owner: SettingsUpdateOwner; mocks: OwnerMocks } => {
  const mocks: OwnerMocks = {
    updateCore: vi.fn<(version?: string) => Promise<ApiResponse>>()
      .mockResolvedValue({ success: true, message: 'core ok' }),
    updateCli: vi.fn<() => Promise<ApiResponse>>()
      .mockResolvedValue({ success: true, message: 'cli ok' }),
    updateResources: vi.fn<() => Promise<ApiResponse>>()
      .mockResolvedValue({ success: true, message: 'resources ok' }),
  }
  if (responses.updateCore) mocks.updateCore.mockReturnValueOnce(responses.updateCore)
  if (responses.updateCli) mocks.updateCli.mockReturnValueOnce(responses.updateCli)
  if (responses.updateResources) mocks.updateResources.mockReturnValueOnce(responses.updateResources)

  return {
    owner: new SettingsUpdateOwner({
      updateCore: version => mocks.updateCore(version),
      updateCli: () => mocks.updateCli(),
      updateResources: () => mocks.updateResources(),
    }),
    mocks,
  }
}

describe('core channel policy', () => {
  it('switches beta/alpha builds back to stable and everything else to beta', () => {
    expect(resolveCoreChannelSwitch('v5.0.0')).toEqual({ version: 'beta', label: 'Beta' })
    expect(resolveCoreChannelSwitch('v5.0.0-beta.1')).toEqual({ version: 'stable', label: '正式版' })
    expect(resolveCoreChannelSwitch('v5.0.0-alpha.2')).toEqual({ version: 'stable', label: '正式版' })
    expect(resolveCoreChannelSwitch(null)).toEqual({ version: 'beta', label: 'Beta' })
    expect(coreChannelLabel('stable')).toBe('正式版')
  })

  it('reads failure details from the current envelope and the legacy error shape', () => {
    expect(readUpdateFailureDetails({
      success: false,
      errorInfo: { details: { failedStep: 'resources', coreUpdated: true } },
    })).toEqual({ failedStep: 'resources', coreUpdated: true })

    expect(readUpdateFailureDetails({
      success: false,
      error: { details: { failedStep: 'core' } } as unknown as string,
    })).toEqual({ failedStep: 'core' })

    expect(readUpdateFailureDetails({ success: false })).toEqual({})
  })

  it('only offers the resource retry for a resource or post-core failure', () => {
    expect(shouldRetryUpdateResources({
      success: false,
      errorInfo: { details: { failedStep: 'resources' } },
    })).toBe(true)
    expect(shouldRetryUpdateResources({
      success: false,
      errorInfo: { details: { coreUpdated: true } },
    })).toBe(true)
    expect(shouldRetryUpdateResources({
      success: false,
      errorInfo: { details: { failedStep: 'core', coreUpdated: false } },
    })).toBe(false)
  })

  it('declares only the scopes actually changed by a resource update', () => {
    expect([...SETTINGS_UPDATE_RESOURCE_SCOPES]).toEqual([
      'catalog',
      'materials',
      'training-plan',
      'dashboard-snapshot',
    ])
  })
})

describe('SettingsUpdateOwner', () => {
  it('starts idle without feedback', () => {
    const { owner } = createOwner()
    expect(owner.getState()).toEqual({ running: null, feedback: null })
  })

  it('reports in-progress state and succeeds with resource and version changes', async () => {
    const pending = deferred<ApiResponse>()
    const { owner, mocks } = createOwner({ updateCore: pending.promise })

    const promise = owner.updateCore()
    expect(owner.getState().running).toBe('core')
    expect(mocks.updateCore).toHaveBeenCalledWith(undefined)

    pending.resolve({ success: true, message: 'MaaCore 和资源已更新' })
    const outcome = await promise

    expect(outcome).toMatchObject({
      status: 'succeeded',
      operation: 'core',
      message: 'MaaCore 和资源已更新',
      resourcesChanged: true,
      versionChanged: true,
      feedback: { type: 'success', message: 'MaaCore 和资源已更新' },
    })
    expect(owner.getState()).toEqual({
      running: null,
      feedback: { type: 'success', message: 'MaaCore 和资源已更新', resourceRetry: false },
    })
  })

  it('clears older feedback when a core or resource command starts', async () => {
    const failed = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        message: '资源同步失败',
        errorInfo: { details: { failedStep: 'resources' } },
      })
      .mockResolvedValueOnce({ success: true, message: '资源文件更新成功' })
    const owner = new SettingsUpdateOwner({
      updateCore: () => failed(),
      updateCli: vi.fn(),
      updateResources: () => failed(),
    })

    await owner.updateCore()
    expect(owner.getState().feedback).toMatchObject({ resourceRetry: true })

    await owner.updateResources()
    expect(owner.getState().running).toBeNull()
    expect(owner.getState().feedback).toEqual({
      type: 'success',
      message: '资源文件更新成功',
      resourceRetry: false,
    })
  })

  it('offers a resource retry on core failures that already updated core or resources', async () => {
    const { owner } = createOwner({
      updateCore: Promise.resolve({
        success: false,
        message: '资源同步失败',
        errorInfo: { details: { failedStep: 'resources', coreUpdated: true } },
      }),
    })

    const outcome = await owner.updateCore()

    expect(outcome.status).toBe('failed')
    expect(outcome.message).toBe('资源同步失败')
    expect(outcome.messageType).toBe('error')
    expect(outcome.resourcesChanged).toBe(false)
    expect(outcome.versionChanged).toBe(false)
    expect(owner.getState().feedback).toEqual({
      type: 'error',
      message: '资源同步失败',
      resourceRetry: true,
    })
  })

  it('reports network failures without retrying the command', async () => {
    const updateCore = vi.fn().mockRejectedValue(new Error('服务未启动'))
    const owner = new SettingsUpdateOwner({ updateCore })

    const outcome = await owner.updateCore()

    expect(updateCore).toHaveBeenCalledOnce()
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toBe('网络错误: 服务未启动')
    expect(outcome.feedback).toEqual({
      type: 'error',
      message: '网络错误: 服务未启动',
      resourceRetry: false,
    })
    expect(owner.getState().running).toBeNull()
  })

  it('keeps CLI updates out of the inline feedback area', async () => {
    const updateCli = vi.fn().mockResolvedValue({ success: true })
    const owner = new SettingsUpdateOwner({
      updateCore: vi.fn(),
      updateCli,
      updateResources: vi.fn().mockResolvedValue({ success: true, message: '资源文件更新成功' }),
    })

    await owner.updateResources()
    const success = await owner.updateCli()

    expect(success.status).toBe('succeeded')
    expect(success.message).toBe('MAA CLI 更新成功')
    expect(success.feedback).toBeNull()
    expect(success.resourcesChanged).toBe(false)
    expect(success.versionChanged).toBe(true)
    // CLI 更新不清空此前的资源更新反馈。
    expect(owner.getState().feedback).toEqual({
      type: 'success',
      message: '资源文件更新成功',
      resourceRetry: false,
    })

    updateCli.mockResolvedValueOnce({ success: false, message: 'brew 不可用' })
    const failure = await owner.updateCli()
    expect(failure.status).toBe('failed')
    expect(failure.feedback).toBeNull()
    expect(failure.message).toBe('更新失败: brew 不可用')
  })

  it('switches channels with the current-version policy and reports the target label', async () => {
    const { owner, mocks } = createOwner()

    const stabilized = await owner.switchCoreChannel('v5.0.0-beta.2')
    expect(mocks.updateCore).toHaveBeenLastCalledWith('stable')
    expect(stabilized).toMatchObject({
      status: 'succeeded',
      operation: 'core-channel',
      message: '已切换到 正式版 渠道并同步最新资源',
      resourcesChanged: true,
    })

    await owner.switchCoreChannel('v5.0.0')
    expect(mocks.updateCore).toHaveBeenLastCalledWith('beta')
  })

  it('marks every resource-only failure as retryable and keeps the server message', async () => {
    const { owner } = createOwner({
      updateResources: Promise.resolve({
        success: false,
        message: '资源同步失败: 下载超时',
        errorInfo: { details: { failedStep: 'resources' } },
      }),
    })

    const outcome = await owner.updateResources()

    expect(outcome.status).toBe('failed')
    expect(outcome.message).toBe('资源同步失败: 下载超时')
    expect(outcome.feedback).toEqual({
      type: 'error',
      message: '资源同步失败: 下载超时',
      resourceRetry: true,
    })
  })

  it('shares one in-flight slot across all update commands', async () => {
    const pending = deferred<ApiResponse>()
    const { owner, mocks } = createOwner({ updateCore: pending.promise })

    const core = owner.updateCore()
    const cli = await owner.updateCli()
    const resources = await owner.updateResources()
    const channel = await owner.switchCoreChannel('v5.0.0')

    expect(cli).toMatchObject({ status: 'ignored', operation: 'cli', message: null })
    expect(resources).toMatchObject({ status: 'ignored', operation: 'resources' })
    expect(channel).toMatchObject({ status: 'ignored', operation: 'core-channel' })
    expect(mocks.updateCli).not.toHaveBeenCalled()
    expect(mocks.updateResources).not.toHaveBeenCalled()
    expect(mocks.updateCore).toHaveBeenCalledOnce()

    pending.resolve({ success: true })
    await core

    expect((await owner.updateCli()).status).toBe('succeeded')
    expect(mocks.updateCli).toHaveBeenCalledOnce()
  })

  it('ignores a duplicate call for the same command while one is in flight', async () => {
    const pending = deferred<ApiResponse>()
    const { owner, mocks } = createOwner({ updateCore: pending.promise })

    const first = owner.updateCore()
    expect((await owner.updateCore()).status).toBe('ignored')
    expect(mocks.updateCore).toHaveBeenCalledOnce()

    pending.resolve({ success: true })
    await first
  })

  it('resets state for tests and explicit global resets', async () => {
    const { owner } = createOwner()
    await owner.updateCore()
    expect(owner.getState().feedback).not.toBeNull()

    owner.reset()
    expect(owner.getState()).toEqual({ running: null, feedback: null })
  })
})
