// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import {
  InstanceOptionsOwner,
  instanceOptionsQueryOptions,
  type InstanceOptionsOwnerOptions,
} from './instanceOptions'
import { DEFAULT_INSTANCE_OPTIONS } from './configNormalization'
import { settingsKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../api', () => ({
  getConfig: apiMocks.getConfig,
  saveConfig: apiMocks.saveConfig,
}))

type WriteRequest = NonNullable<InstanceOptionsOwnerOptions['write']>

const createOwner = (write?: WriteRequest) => (
  new InstanceOptionsOwner(write ? { write } : {})
)

describe('instance options owner', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockReset()
    apiMocks.saveConfig.mockReset()
  })

  it('starts from the MaaCore defaults and tracks edits', () => {
    const owner = createOwner()

    expect(owner.getState()).toMatchObject({
      draft: DEFAULT_INSTANCE_OPTIONS,
      persisted: DEFAULT_INSTANCE_OPTIONS,
      dirty: false,
      loaded: false,
    })

    expect(owner.update({ touch_mode: 'MaaTouch' })).toBe(true)
    expect(owner.getState()).toMatchObject({
      draft: { ...DEFAULT_INSTANCE_OPTIONS, touch_mode: 'MaaTouch' },
      revision: 1,
      dirty: true,
    })
  })

  it('adopts a read that normalizes missing fields and keeps unknown options', () => {
    const owner = createOwner()
    const token = owner.beginRead()

    expect(owner.adoptServer({
      config: { ...DEFAULT_INSTANCE_OPTIONS, touch_mode: 'MiniTouch', custom_flag: 'kept' },
      readToken: token,
    })).toBe(true)
    expect(owner.getState().draft).toEqual({
      ...DEFAULT_INSTANCE_OPTIONS,
      touch_mode: 'MiniTouch',
      custom_flag: 'kept',
    })
  })

  it('saves only the instance options section by default', async () => {
    apiMocks.saveConfig.mockResolvedValue({ success: true })
    const owner = createOwner()

    owner.update({ adb_lite_enabled: true })
    await expect(owner.save()).resolves.toMatchObject({ status: 'saved', superseded: false })

    expect(apiMocks.saveConfig).toHaveBeenCalledWith('default', {
      instance_options: { ...DEFAULT_INSTANCE_OPTIONS, adb_lite_enabled: true },
    })
  })

  it('keeps the draft and reports the message when the write fails', async () => {
    apiMocks.saveConfig.mockResolvedValue({ success: false, message: '磁盘只读' })
    const owner = createOwner()
    owner.update({ deployment_with_pause: true })

    await expect(owner.save()).resolves.toMatchObject({ status: 'failed', message: '磁盘只读' })
    expect(owner.getState()).toMatchObject({
      draft: { ...DEFAULT_INSTANCE_OPTIONS, deployment_with_pause: true },
      syncState: 'failed',
      error: '磁盘只读',
    })
  })

  it('resets the draft to the MaaCore defaults', () => {
    const owner = createOwner()
    owner.update({ kill_adb_on_exit: true })

    expect(owner.restoreDefaults()).toBe(true)
    expect(owner.getState().draft).toEqual(DEFAULT_INSTANCE_OPTIONS)
  })
})

describe('instance options query', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockReset()
  })

  it('uses its own key and extracts the instance options section', async () => {
    apiMocks.getConfig.mockResolvedValue({
      success: true,
      data: {
        connection: { address: '127.0.0.1:5555' },
        instance_options: { touch_mode: 'MaaTouch', deployment_with_pause: true },
      },
    })
    const owner = createOwner()
    const options = instanceOptionsQueryOptions('default', owner)

    expect(options.queryKey).toEqual(settingsKeys.query('maa-instance-options', 'default'))
    expect(options.queryKey).toEqual(['settings', 'maa-instance-options', 'default'])

    const data = await createQueryClient().fetchQuery(options)

    expect(apiMocks.getConfig).toHaveBeenCalledWith('default', expect.any(AbortSignal))
    expect(data.config).toMatchObject({ touch_mode: 'MaaTouch', deployment_with_pause: true })
    expect(data.readToken).toEqual(owner.beginRead())
  })

  it('falls back to the MaaCore defaults when the profile has no instance section', async () => {
    apiMocks.getConfig.mockResolvedValue({
      success: true,
      data: { connection: { address: '127.0.0.1:5555' } },
    })

    const data = await createQueryClient().fetchQuery(instanceOptionsQueryOptions('default', createOwner()))

    expect(data.config).toEqual(DEFAULT_INSTANCE_OPTIONS)
  })

  it('turns a non-record instance section into a contract failure', async () => {
    apiMocks.getConfig.mockResolvedValue({
      success: true,
      data: { connection: {}, instance_options: 'touch' },
    })

    const error = await createQueryClient()
      .fetchQuery(instanceOptionsQueryOptions('default', createOwner()))
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'contract', code: 'INVALID_DOMAIN_PAYLOAD' })
  })
})
