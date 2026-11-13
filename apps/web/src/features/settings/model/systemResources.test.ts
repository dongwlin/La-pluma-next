// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import {
  configDirectoryQueryOptions,
  normalizeConfigDirectoryPath,
  normalizeMaaVersionInfo,
  versionQueryOptions,
} from './systemResources'
import { settingsKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getConfigDir: vi.fn(),
}))

vi.mock('../api', () => ({
  getVersion: apiMocks.getVersion,
  getConfigDir: apiMocks.getConfigDir,
}))

describe('settings system resources', () => {
  beforeEach(() => {
    apiMocks.getVersion.mockReset()
    apiMocks.getConfigDir.mockReset()
  })

  it('uses the reserved version key and forwards the query signal', async () => {
    apiMocks.getVersion.mockResolvedValue({
      success: true,
      data: {
        cli: 'v0.7.3',
        core: 'v5.12.3',
        raw: 'maa-cli v0.7.3\nMaaCore v5.12.3',
        resource: {
          lastUpdated: '2026-10-24 03:30:00',
          modifiedAt: null,
          ageDays: 0,
          status: 'current',
          message: '资源与最新版本一致',
        },
      },
    })

    const options = versionQueryOptions()
    expect(options.queryKey).toEqual(settingsKeys.query('version'))
    expect(options.queryKey).toEqual(['settings', 'version'])

    const data = await createQueryClient().fetchQuery(options)

    expect(apiMocks.getVersion).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(data).toEqual({
      cli: 'v0.7.3',
      core: 'v5.12.3',
      raw: 'maa-cli v0.7.3\nMaaCore v5.12.3',
      resource: {
        lastUpdated: '2026-10-24 03:30:00',
        modifiedAt: null,
        ageDays: 0,
        status: 'current',
        message: '资源与最新版本一致',
      },
    })
  })

  it('normalizes unknown resource fields and omits a missing resource block', () => {
    expect(normalizeMaaVersionInfo({ cli: 'cli', core: 'core', raw: 'raw' })).toEqual({
      cli: 'cli',
      core: 'core',
      raw: 'raw',
    })
    expect(normalizeMaaVersionInfo({
      cli: 'cli',
      core: 'core',
      raw: 'raw',
      resource: { status: 'weird', lastUpdated: 7, ageDays: 'old' },
    })).toEqual({
      cli: 'cli',
      core: 'core',
      raw: 'raw',
      resource: {
        lastUpdated: null,
        modifiedAt: null,
        ageDays: null,
        status: 'unknown',
        message: '',
      },
    })
    expect(normalizeMaaVersionInfo({ cli: 'cli', core: 5, raw: 'raw' })).toBeNull()
  })

  it('turns an unusable version payload into a contract failure', async () => {
    apiMocks.getVersion.mockResolvedValue({ success: true, data: { cli: 1, core: null } })

    const error = await createQueryClient()
      .fetchQuery(versionQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      kind: 'contract',
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '版本信息格式不正确',
    })
  })

  it('turns a failed version envelope into a query error', async () => {
    apiMocks.getVersion.mockResolvedValue({ success: false, message: '版本服务不可用' })

    const error = await createQueryClient()
      .fetchQuery(versionQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ message: '版本服务不可用' })
  })

  it('reads both legacy and current config-directory payloads under one key', async () => {
    apiMocks.getConfigDir
      .mockResolvedValueOnce({ success: true, data: '/tmp/la-pluma' })
      .mockResolvedValueOnce({ success: true, data: { path: '/opt/maa/config' } })
    const options = configDirectoryQueryOptions()

    expect(options.queryKey).toEqual(settingsKeys.query('config-directory'))
    expect(options.queryKey).toEqual(['settings', 'config-directory'])

    await expect(createQueryClient().fetchQuery(options)).resolves.toBe('/tmp/la-pluma')
    await expect(createQueryClient().fetchQuery(options)).resolves.toBe('/opt/maa/config')
    expect(apiMocks.getConfigDir).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('rejects a blank config directory as a contract failure', async () => {
    apiMocks.getConfigDir.mockResolvedValue({ success: true, data: { path: '  ' } })

    const error = await createQueryClient()
      .fetchQuery(configDirectoryQueryOptions())
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      kind: 'contract',
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '配置目录格式不正确',
    })
  })

  it('keeps the config directory normalizer tolerant of the legacy string', () => {
    expect(normalizeConfigDirectoryPath('/tmp/la-pluma')).toBe('/tmp/la-pluma')
    expect(normalizeConfigDirectoryPath({ path: '/opt/maa/config' })).toBe('/opt/maa/config')
    expect(normalizeConfigDirectoryPath('')).toBeNull()
    expect(normalizeConfigDirectoryPath({ path: '' })).toBeNull()
    expect(normalizeConfigDirectoryPath({})).toBeNull()
    expect(normalizeConfigDirectoryPath(42)).toBeNull()
  })
})
