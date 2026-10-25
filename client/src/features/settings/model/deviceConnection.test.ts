// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import { ConnectionConfigOwner } from './connectionConfig'
import {
  DeviceConnectionOwner,
  type DeviceConnectionOwnerOptions,
  type DiscoveredDevice,
} from './deviceConnection'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const ok = <T,>(data: T, message?: string): ApiResponse<T> => ({ success: true, data, message })

type DiscoverRequest = NonNullable<DeviceConnectionOwnerOptions['discover']>
type TestRequest = NonNullable<DeviceConnectionOwnerOptions['test']>

const createConnection = () => new ConnectionConfigOwner({
  write: vi.fn(async () => ({ success: true })),
})

const createOwner = ({
  connection = createConnection(),
  discover = vi.fn<DiscoverRequest>(async () => ok({ success: true })),
  test = vi.fn<TestRequest>(async () => ok({ success: true })),
}: {
  connection?: ConnectionConfigOwner
  discover?: DiscoverRequest
  test?: TestRequest
} = {}) => ({
  connection,
  discover,
  test,
  owner: new DeviceConnectionOwner({ connection, discover, test }),
})

const device = (overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice => ({
  address: '127.0.0.1:16384',
  state: 'device',
  source: 'adb',
  ...overrides,
})

describe('settings device connection owner', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('starts idle with independent discovery and test state', () => {
    const { owner } = createOwner()

    expect(owner.getState()).toEqual({
      discovery: {
        phase: 'idle',
        devices: [],
        message: null,
        error: null,
        searched: false,
      },
      test: {
        phase: 'idle',
        address: null,
        success: false,
        message: null,
        error: null,
        draftRevision: null,
        superseded: false,
      },
    })
  })

  it('discovers devices with the draft adb path and its own signal', async () => {
    const { owner, discover } = createOwner({
      discover: vi.fn<DiscoverRequest>(async () => ok({
        success: true,
        message: '找到 2 个设备或可尝试地址',
        devices: [
          { address: 'emulator-5554', state: 'device', details: 'ADB 已识别', source: 'adb' },
          { address: '127.0.0.1:5555', state: 'offline', source: 'emulator-adb', adbPath: 'C:/adb.exe' },
        ],
        candidates: [
          { address: '127.0.0.1:16384', state: 'candidate', source: 'local-port' },
        ],
      })),
    })

    const pending = owner.discover('/opt/homebrew/bin/adb')
    expect(owner.getState().discovery.phase).toBe('running')
    expect(owner.getState().test.phase).toBe('idle')

    const outcome = await pending

    expect(discover).toHaveBeenCalledWith('/opt/homebrew/bin/adb', expect.any(AbortSignal))
    expect(outcome.status).toBe('succeeded')
    expect(outcome.devices.map(item => item.address)).toEqual([
      'emulator-5554',
      '127.0.0.1:5555',
      '127.0.0.1:16384',
    ])
    expect(owner.getState().discovery).toMatchObject({
      phase: 'succeeded',
      message: '找到 2 个设备或可尝试地址',
      error: null,
      searched: true,
    })
    expect(owner.getState().discovery.devices[1]).toMatchObject({
      source: 'emulator-adb',
      adbPath: 'C:/adb.exe',
    })
  })

  it('skips malformed device rows and defaults unknown state/source', async () => {
    const { owner } = createOwner({
      discover: vi.fn<DiscoverRequest>(async () => ok({
        success: true,
        message: '已查找',
        devices: [
          { address: 'emulator-5554', state: 'mystery', source: 'wherever' },
          { address: '' },
          { state: 'device' },
          'not-a-device',
        ],
        candidates: 'not-an-array',
      })),
    })

    await owner.discover('/adb')

    expect(owner.getState().discovery.devices).toEqual([
      { address: 'emulator-5554', state: 'unknown', source: 'adb' },
    ])
  })

  it('reports an inner discovery failure without clearing the devices list shape', async () => {
    const { owner } = createOwner({
      discover: vi.fn<DiscoverRequest>(async () => ok({
        success: false,
        adbAvailable: false,
        message: 'ADB 不可用，请检查 ADB 路径或启动模拟器后重试',
        devices: [],
        candidates: [],
        error: '未找到可用的 ADB',
      })),
    })

    const outcome = await owner.discover('/missing/adb')

    expect(outcome).toMatchObject({
      status: 'failed',
      devices: [],
      message: 'ADB 不可用，请检查 ADB 路径或启动模拟器后重试',
    })
    expect(owner.getState().discovery).toMatchObject({
      phase: 'failed',
      devices: [],
      message: 'ADB 不可用，请检查 ADB 路径或启动模拟器后重试',
      error: 'ADB 不可用，请检查 ADB 路径或启动模拟器后重试',
      searched: true,
    })
  })

  it('clears devices and reports an envelope failure', async () => {
    const { owner } = createOwner({
      discover: vi.fn<DiscoverRequest>(async () => ({
        success: false,
        message: '设备发现服务暂不可用',
      })),
    })

    await owner.discover('/adb')

    expect(owner.getState().discovery).toMatchObject({
      phase: 'failed',
      devices: [],
      message: '设备发现服务暂不可用',
      error: '设备发现服务暂不可用',
      searched: true,
    })
  })

  it('prefixes transport failures and keeps the retry entry available', async () => {
    const { owner } = createOwner({
      discover: vi.fn<DiscoverRequest>(async () => {
        throw new Error('无法连接后端服务')
      }),
    })

    const outcome = await owner.discover('/adb')

    expect(outcome).toMatchObject({
      status: 'failed',
      message: '查找设备失败: 无法连接后端服务',
    })
    expect(owner.getState().discovery).toMatchObject({
      phase: 'failed',
      message: '查找设备失败: 无法连接后端服务',
      error: '查找设备失败: 无法连接后端服务',
      searched: true,
    })
  })

  it('cancels an in-flight discovery and ignores its late response', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const discover = vi.fn<DiscoverRequest>(() => pending.promise)
    const { owner } = createOwner({ discover })

    const outcomePromise = owner.discover('/adb')
    const signal = discover.mock.calls[0]![1]!
    owner.cancelDiscovery()

    expect(signal.aborted).toBe(true)
    expect(owner.getState().discovery.phase).toBe('cancelled')
    expect(owner.getState().discovery.searched).toBe(false)

    pending.resolve(ok({
      success: true,
      message: '迟到的结果',
      devices: [device()],
    }))

    await expect(outcomePromise).resolves.toMatchObject({
      status: 'cancelled',
      devices: [],
      message: null,
    })
    expect(owner.getState().discovery).toMatchObject({
      phase: 'cancelled',
      devices: [],
      message: null,
    })
  })

  it('lets a newer discovery supersede an older one without mixing results', async () => {
    const first = deferred<ApiResponse<unknown>>()
    const second = deferred<ApiResponse<unknown>>()
    const discover = vi.fn<DiscoverRequest>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { owner } = createOwner({ discover })

    const firstPromise = owner.discover('/first-adb')
    const firstSignal = discover.mock.calls[0]![1]!
    const secondPromise = owner.discover('/second-adb')

    expect(firstSignal.aborted).toBe(true)

    first.resolve(ok({
      success: true,
      message: '旧结果',
      devices: [device({ address: 'stale-device' })],
    }))
    await expect(firstPromise).resolves.toMatchObject({ status: 'cancelled' })

    second.resolve(ok({
      success: true,
      message: '新结果',
      devices: [device({ address: 'fresh-device' })],
    }))
    await expect(secondPromise).resolves.toMatchObject({ status: 'succeeded' })

    expect(owner.getState().discovery.devices.map(item => item.address)).toEqual(['fresh-device'])
    expect(owner.getState().discovery.message).toBe('新结果')
  })

  it('tests a connection with its own signal and records the draft revision', async () => {
    const { owner, connection, test } = createOwner({
      test: vi.fn<TestRequest>(async () => ok({
        success: true,
        connected: true,
        message: '已连接到 127.0.0.1:5555',
      })),
    })
    connection.update({ address: '127.0.0.1:5555' })

    const pending = owner.test('/opt/homebrew/bin/adb', '127.0.0.1:5555')
    expect(owner.getState().test.phase).toBe('running')

    const outcome = await pending

    expect(test).toHaveBeenCalledWith('/opt/homebrew/bin/adb', '127.0.0.1:5555', expect.any(AbortSignal))
    expect(outcome).toMatchObject({
      status: 'succeeded',
      address: '127.0.0.1:5555',
      success: true,
      message: '已连接到 127.0.0.1:5555',
      superseded: false,
    })
    expect(owner.getState().test).toMatchObject({
      phase: 'succeeded',
      address: '127.0.0.1:5555',
      success: true,
      message: '已连接到 127.0.0.1:5555',
      error: null,
      draftRevision: 1,
      superseded: false,
    })
  })

  it('treats a completed negative connection result as a settled test', async () => {
    const { owner } = createOwner({
      test: vi.fn<TestRequest>(async () => ok({
        success: false,
        message: '设备 127.0.0.1:5555 未授权，请在模拟器中允许 USB 调试',
      })),
    })

    const outcome = await owner.test('/adb', '127.0.0.1:5555')

    expect(outcome).toMatchObject({
      status: 'succeeded',
      success: false,
      message: '设备 127.0.0.1:5555 未授权，请在模拟器中允许 USB 调试',
    })
    expect(owner.getState().test).toMatchObject({
      phase: 'succeeded',
      success: false,
      error: null,
    })
  })

  it('marks the test result as superseded when the draft changed meanwhile', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const { owner, connection } = createOwner({
      test: vi.fn<TestRequest>(() => pending.promise),
    })
    connection.update({ address: '127.0.0.1:5555' })

    const outcomePromise = owner.test('/adb', '127.0.0.1:5555')
    connection.update({ address: '127.0.0.1:6666' })
    pending.resolve(ok({ success: true, message: '已连接到 127.0.0.1:5555' }))

    const outcome = await outcomePromise

    expect(outcome.superseded).toBe(true)
    expect(owner.getState().test.superseded).toBe(true)
    expect(connection.getState().draft.address).toBe('127.0.0.1:6666')
  })

  it('reports request-level test failures separately from negative results', async () => {
    const { owner } = createOwner({
      test: vi.fn<TestRequest>(async () => {
        throw new Error('连接超时')
      }),
    })

    const outcome = await owner.test('/adb', '127.0.0.1:5555')

    expect(outcome).toMatchObject({
      status: 'failed',
      success: false,
      message: '连接测试失败: 连接超时',
    })
    expect(owner.getState().test).toMatchObject({
      phase: 'failed',
      success: false,
      message: '连接测试失败: 连接超时',
      error: '连接测试失败: 连接超时',
    })
  })

  it('cancels an in-flight test and ignores its late response', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const test = vi.fn<TestRequest>(() => pending.promise)
    const { owner } = createOwner({ test })

    const outcomePromise = owner.test('/adb', '127.0.0.1:5555')
    const signal = test.mock.calls[0]![2]!
    owner.cancelTest()

    expect(signal.aborted).toBe(true)
    expect(owner.getState().test.phase).toBe('cancelled')

    pending.resolve(ok({ success: true, message: '迟到的连接结果' }))
    await expect(outcomePromise).resolves.toMatchObject({
      status: 'cancelled',
      message: null,
      success: false,
    })
    expect(owner.getState().test).toMatchObject({
      phase: 'cancelled',
      message: null,
      success: false,
    })
  })

  it('clears settled feedback but keeps a running test loading', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const { owner } = createOwner({
      test: vi.fn<TestRequest>(() => pending.promise),
    })

    const outcomePromise = owner.test('/adb', '127.0.0.1:5555')
    owner.clearTestFeedback()
    expect(owner.getState().test.phase).toBe('running')

    pending.resolve(ok({ success: true, message: '已连接' }))
    await outcomePromise
    expect(owner.getState().test.message).toBe('已连接')

    owner.clearTestFeedback()
    expect(owner.getState().test).toMatchObject({
      phase: 'idle',
      message: null,
      error: null,
      success: false,
    })
  })

  it('cancels both command chains for Activity cleanup', async () => {
    const discovery = deferred<ApiResponse<unknown>>()
    const test = deferred<ApiResponse<unknown>>()
    const discover = vi.fn<DiscoverRequest>(() => discovery.promise)
    const testRequest = vi.fn<TestRequest>(() => test.promise)
    const { owner } = createOwner({ discover, test: testRequest })

    void owner.discover('/adb')
    void owner.test('/adb', '127.0.0.1:5555')
    owner.cancelAll()

    expect(discover.mock.calls[0]![1]!.aborted).toBe(true)
    expect(testRequest.mock.calls[0]![2]!.aborted).toBe(true)
    expect(owner.getState().discovery.phase).toBe('cancelled')
    expect(owner.getState().test.phase).toBe('cancelled')
  })

  it('backfills the latest draft before testing a discovered device', async () => {
    const pending = deferred<ApiResponse<unknown>>()
    const { owner, connection, test } = createOwner({
      test: vi.fn<TestRequest>(() => pending.promise),
    })
    connection.update({
      adb_path: '/edited/adb',
      address: '127.0.0.1:1111',
      touch_mode: 'minitouch',
      auto_reconnect: false,
    })

    const outcomePromise = owner.selectDiscoveredDevice(device({
      address: '127.0.0.1:16384',
      adbPath: 'C:/emulator/adb.exe',
    }))

    expect(test).toHaveBeenCalledWith(
      'C:/emulator/adb.exe',
      '127.0.0.1:16384',
      expect.any(AbortSignal),
    )
    expect(connection.getState().draft).toMatchObject({
      adb_path: 'C:/emulator/adb.exe',
      address: '127.0.0.1:16384',
      touch_mode: 'minitouch',
      auto_reconnect: false,
    })

    connection.update({ address: '127.0.0.1:6666' })
    pending.resolve(ok({ success: true, message: '已连接' }))

    const outcome = await outcomePromise

    expect(outcome.superseded).toBe(true)
    expect(connection.getState().draft).toMatchObject({
      adb_path: 'C:/emulator/adb.exe',
      address: '127.0.0.1:6666',
      touch_mode: 'minitouch',
    })
  })

  it('keeps a discovered-device backfill when an earlier server read returns late', async () => {
    const { owner, connection } = createOwner({
      test: vi.fn<TestRequest>(async () => ok({ success: true, message: '已连接' })),
    })
    const readToken = connection.beginRead()

    await owner.selectDiscoveredDevice(device({ address: '127.0.0.1:5555' }))

    const adopted = connection.adoptServer({
      config: { ...connection.getState().draft, address: '10.0.0.2:5555' },
      readToken,
    })

    expect(adopted).toBe(false)
    expect(connection.getState().draft.address).toBe('127.0.0.1:5555')
  })

  it('uses the latest draft adb path when the discovered device has none', () => {
    const { owner, connection, test } = createOwner({
      test: vi.fn<TestRequest>(() => deferred<ApiResponse<unknown>>().promise),
    })

    connection.update({ adb_path: '/updated/adb' })
    void owner.selectDiscoveredDevice(device({ address: '127.0.0.1:16384' }))

    expect(test).toHaveBeenCalledWith(
      '/updated/adb',
      '127.0.0.1:16384',
      expect.any(AbortSignal),
    )
  })

  it('resets to the initial state and aborts in-flight chains', async () => {
    const discovery = deferred<ApiResponse<unknown>>()
    const discover = vi.fn<DiscoverRequest>(() => discovery.promise)
    const { owner } = createOwner({ discover })
    void owner.discover('/adb')

    owner.reset()

    expect(discover.mock.calls[0]![1]!.aborted).toBe(true)
    expect(owner.getState()).toEqual({
      discovery: {
        phase: 'idle',
        devices: [],
        message: null,
        error: null,
        searched: false,
      },
      test: {
        phase: 'idle',
        address: null,
        success: false,
        message: null,
        error: null,
        draftRevision: null,
        superseded: false,
      },
    })
  })
})
