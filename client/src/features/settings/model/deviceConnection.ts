/**
 * 设置页设备发现与连接测试所有者
 *
 * 设备发现会探测本机 ADB 与常见模拟器端口，连接测试会尝试 `adb connect`，
 * 两者都是带副作用的显式命令，不是只读资源：不进入 Query，也不自动重试。
 * 本模块持有两条互不影响的命令链：
 *
 * - 两条链各自只有一次在途请求；重复发起会取消旧请求，旧响应不写状态。
 * - loading/error/取消分别属于 discovery 与 test，一个操作的进行或失败不会
 *   改写另一个操作的 loading。
 * - 页面隐藏或卸载时由 hook 调用 `cancelAll()`：只结束本地等待，不撤销服务端
 *   已发生的探测/连接；恢复后保留已完成的结果，用户可重新发起。
 * - 选择发现结果时只把 `adb_path`/`address` 合并进当前草稿，并记录当时的草稿
 *   revision；测试响应不写草稿，因此测试期间的新编辑不会被旧结果覆盖。
 */

import { getErrorMessage, isAbortError, isRecord, type ApiResponse } from '@/shared/api'
import {
  discoverDevices as defaultDiscoverDevices,
  testConnection as defaultTestConnection,
} from '../api'
import {
  settingsConnectionOwner,
  type ConnectionConfigOwner,
} from './connectionConfig'

export const DISCOVERED_DEVICE_STATES = [
  'device',
  'offline',
  'unauthorized',
  'unknown',
  'candidate',
] as const

export type DiscoveredDeviceState = (typeof DISCOVERED_DEVICE_STATES)[number]

export const DISCOVERED_DEVICE_SOURCES = ['adb', 'local-port', 'emulator-adb'] as const

export type DiscoveredDeviceSource = (typeof DISCOVERED_DEVICE_SOURCES)[number]

export interface DiscoveredDevice {
  readonly address: string
  readonly state: DiscoveredDeviceState
  readonly details?: string
  readonly adbPath?: string
  readonly source: DiscoveredDeviceSource
}

/** 命令生命周期；`cancelled` 不展示为失败。 */
export type DeviceOperationPhase =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface DeviceDiscoveryState {
  readonly phase: DeviceOperationPhase
  readonly devices: readonly DiscoveredDevice[]
  /** 可直接展示的提示；服务端 `message` 或本地失败说明。 */
  readonly message: string | null
  /** 请求或服务端业务失败原因；成功与取消时为 null。 */
  readonly error: string | null
  /** 是否完成过一次查找；取消不算完成，页面据此显示空结果提示。 */
  readonly searched: boolean
}

export interface ConnectionTestState {
  readonly phase: DeviceOperationPhase
  readonly address: string | null
  /** 连接结果；请求失败与取消都为 false。 */
  readonly success: boolean
  readonly message: string | null
  /** 请求级失败原因；连接未建立但请求完成时为 null。 */
  readonly error: string | null
  /** 发起测试时的草稿 revision，用于判断测试期间是否有新编辑。 */
  readonly draftRevision: number | null
  /** 测试期间草稿已推进；结果仍展示，但不代表当前表单目标。 */
  readonly superseded: boolean
}

export interface DeviceConnectionState {
  readonly discovery: DeviceDiscoveryState
  readonly test: ConnectionTestState
}

export interface DeviceDiscoveryOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly devices: readonly DiscoveredDevice[]
  readonly message: string | null
}

export interface ConnectionTestOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly address: string
  readonly success: boolean
  readonly message: string | null
  readonly superseded: boolean
}

type DiscoverRequest = (
  adbPath: string,
  signal?: AbortSignal,
) => Promise<ApiResponse<unknown>>

type TestRequest = (
  adbPath: string,
  address: string,
  signal?: AbortSignal,
) => Promise<ApiResponse<unknown>>

export interface DeviceConnectionOwnerOptions {
  readonly connection?: ConnectionConfigOwner
  readonly discover?: DiscoverRequest
  readonly test?: TestRequest
}

const initialState = (): DeviceConnectionState => ({
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

const describeError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : '未知错误'
)

const isState = (value: unknown, states: readonly string[]): boolean => (
  typeof value === 'string' && states.includes(value)
)

const normalizeDevice = (value: unknown): DiscoveredDevice | null => {
  if (!isRecord(value) || typeof value.address !== 'string' || !value.address.trim()) {
    return null
  }

  const state = isState(value.state, DISCOVERED_DEVICE_STATES)
    ? value.state as DiscoveredDeviceState
    : 'unknown'
  const source = isState(value.source, DISCOVERED_DEVICE_SOURCES)
    ? value.source as DiscoveredDeviceSource
    : 'adb'

  const device: {
    address: string
    state: DiscoveredDeviceState
    details?: string
    adbPath?: string
    source: DiscoveredDeviceSource
  } = { address: value.address, state, source }

  if (typeof value.details === 'string' && value.details.trim()) {
    device.details = value.details
  }
  if (typeof value.adbPath === 'string' && value.adbPath.trim()) {
    device.adbPath = value.adbPath
  }
  return device
}

/** 旧页面直接展开 `devices`/`candidates`；非数组或坏条目按空值/跳过处理。 */
export const normalizeDiscoveredDevices = (value: unknown): DiscoveredDevice[] => (
  Array.isArray(value)
    ? value.flatMap(item => {
        const device = normalizeDevice(item)
        return device ? [device] : []
      })
    : []
)

const withTestFeedbackCleared = (test: ConnectionTestState): ConnectionTestState => {
  if (test.message === null && test.error === null && !test.success) return test
  return {
    ...test,
    phase: test.phase === 'running' ? 'running' : 'idle',
    success: false,
    message: null,
    error: null,
    superseded: false,
  }
}

/** 一次测试的完成快照；地址在发起时已确定，不会为 null。 */
interface ConnectionTestSnapshot {
  readonly phase: DeviceOperationPhase
  readonly address: string
  readonly success: boolean
  readonly message: string | null
  readonly error: string | null
  readonly draftRevision: number | null
}

/**
 * 模块级设备命令所有者。
 *
 * 寿命不跟随页面：Activity 隐藏或页面重挂载不会重建正在进行的两条命令链；
 * hook 只在 Effect cleanup 中取消本地等待，不调用服务端停止接口。
 */
export class DeviceConnectionOwner {
  private readonly connection: ConnectionConfigOwner
  private readonly discoverRequest: DiscoverRequest
  private readonly testRequest: TestRequest

  private state: DeviceConnectionState = initialState()
  private discoveryController: AbortController | null = null
  private testController: AbortController | null = null
  private readonly listeners = new Set<() => void>()

  constructor(options: DeviceConnectionOwnerOptions = {}) {
    this.connection = options.connection ?? settingsConnectionOwner
    this.discoverRequest = options.discover ?? defaultDiscoverDevices
    this.testRequest = options.test ?? defaultTestConnection
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): DeviceConnectionState => this.state

  /** 仅用于测试与明确的全局重置；正常页面生命周期不调用。 */
  reset(): void {
    this.abortDiscovery()
    this.abortTest()
    this.state = initialState()
    this.notify()
  }

  /**
   * 查找设备。新查找会取消仍在途的旧查找；旧响应不写状态。
   *
   * 与迁移前一致，查找开始会清空连接测试的反馈，但不取消在途测试。
   */
  async discover(adbPath: string): Promise<DeviceDiscoveryOutcome> {
    this.abortDiscovery()
    const controller = new AbortController()
    this.discoveryController = controller

    this.state = {
      discovery: {
        ...this.state.discovery,
        phase: 'running',
        message: null,
        error: null,
      },
      test: withTestFeedbackCleared(this.state.test),
    }
    this.notify()

    let response: ApiResponse<unknown>
    try {
      response = await this.discoverRequest(adbPath, controller.signal)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return this.finishCancelledDiscovery(controller)
      }
      const message = `查找设备失败: ${describeError(error)}`
      return this.commitDiscovery(controller, 'failed', [], message, message)
    }

    if (controller.signal.aborted || this.discoveryController !== controller) {
      return this.cancelledDiscoveryOutcome()
    }

    if (!response.success) {
      const message = getErrorMessage(response)
      return this.commitDiscovery(controller, 'failed', [], message, message)
    }

    const payload = isRecord(response.data) ? response.data : null
    const devices = payload
      ? [
          ...normalizeDiscoveredDevices(payload.devices),
          ...normalizeDiscoveredDevices(payload.candidates),
        ]
      : []
    const message = payload && typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : getErrorMessage(response)
    const businessSuccess = payload?.success !== false

    return businessSuccess
      ? this.commitDiscovery(controller, 'succeeded', devices, message, null)
      : this.commitDiscovery(controller, 'failed', devices, message, message)
  }

  /**
   * 测试连接。新测试会取消仍在途的旧测试；测试响应从不写草稿。
   */
  async test(
    adbPath: string,
    address: string,
    draftRevision = this.connection.getState().revision,
  ): Promise<ConnectionTestOutcome> {
    this.abortTest()
    const controller = new AbortController()
    this.testController = controller

    this.state = {
      ...this.state,
      test: {
        phase: 'running',
        address,
        success: false,
        message: null,
        error: null,
        draftRevision,
        superseded: false,
      },
    }
    this.notify()

    let response: ApiResponse<unknown>
    try {
      response = await this.testRequest(adbPath, address, controller.signal)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return this.finishCancelledTest(controller, address)
      }
      const message = `连接测试失败: ${describeError(error)}`
      return this.commitTest(
        controller,
        { phase: 'failed', address, success: false, message, error: message, draftRevision },
      )
    }

    if (controller.signal.aborted || this.testController !== controller) {
      return this.cancelledTestOutcome(address)
    }

    const payload = isRecord(response.data) ? response.data : null
    const success = Boolean(response.success && payload?.success)
    const message = payload && typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : getErrorMessage(response)

    return this.commitTest(
      controller,
      {
        phase: response.success ? 'succeeded' : 'failed',
        address,
        success,
        message,
        error: response.success ? null : message,
        draftRevision,
      },
    )
  }

  /**
   * 选择发现结果：把 `adb_path`/`address` 合并进当前草稿，再测试该地址。
   *
   * 回填读取的是点击时的最新草稿：设备自带 `adbPath` 时使用它，否则沿用
   * 草稿里最新的 ADB 路径；`ConnectionConfigOwner.update()` 只合并这两个字段，
   * 不会用发现时的旧快照覆盖期间的新编辑或丢弃未知字段。
   */
  selectDiscoveredDevice(device: DiscoveredDevice): Promise<ConnectionTestOutcome> {
    const adbPath = device.adbPath || this.connection.getState().draft.adb_path
    this.connection.update({ adb_path: adbPath, address: device.address })
    return this.test(adbPath, device.address, this.connection.getState().revision)
  }

  /** 地址编辑后清除旧反馈；在途测试继续，loading 不变。 */
  clearTestFeedback(): void {
    const next = withTestFeedbackCleared(this.state.test)
    if (next === this.state.test) return
    this.state = { ...this.state, test: next }
    this.notify()
  }

  cancelDiscovery(): void {
    const controller = this.discoveryController
    if (!controller) return
    this.discoveryController = null
    controller.abort()
    this.state = {
      ...this.state,
      discovery: { ...this.state.discovery, phase: 'cancelled' },
    }
    this.notify()
  }

  cancelTest(): void {
    const controller = this.testController
    if (!controller) return
    this.testController = null
    controller.abort()
    this.state = {
      ...this.state,
      test: {
        ...this.state.test,
        phase: 'cancelled',
        success: false,
        message: null,
        error: null,
      },
    }
    this.notify()
  }

  /** Activity 隐藏/页面卸载时取消两条命令的本地等待。 */
  cancelAll(): void {
    this.cancelDiscovery()
    this.cancelTest()
  }

  private commitDiscovery(
    controller: AbortController,
    phase: 'succeeded' | 'failed',
    devices: readonly DiscoveredDevice[],
    message: string,
    error: string | null,
  ): DeviceDiscoveryOutcome {
    if (this.discoveryController !== controller) return this.cancelledDiscoveryOutcome()
    this.discoveryController = null
    this.state = {
      ...this.state,
      discovery: {
        phase,
        devices,
        message,
        error,
        searched: true,
      },
    }
    this.notify()
    return { status: phase, devices, message }
  }

  private finishCancelledDiscovery(controller: AbortController): DeviceDiscoveryOutcome {
    if (this.discoveryController === controller) {
      this.discoveryController = null
      this.state = {
        ...this.state,
        discovery: { ...this.state.discovery, phase: 'cancelled' },
      }
      this.notify()
    }
    return this.cancelledDiscoveryOutcome()
  }

  private cancelledDiscoveryOutcome(): DeviceDiscoveryOutcome {
    return {
      status: 'cancelled',
      devices: this.state.discovery.devices,
      message: null,
    }
  }

  private commitTest(
    controller: AbortController,
    result: ConnectionTestSnapshot,
  ): ConnectionTestOutcome {
    const superseded = this.connection.getState().revision !== result.draftRevision
    if (this.testController !== controller) {
      return { status: 'cancelled', address: result.address, success: false, message: null, superseded }
    }

    this.testController = null
    this.state = {
      ...this.state,
      test: { ...result, superseded },
    }
    this.notify()
    return {
      status: result.phase === 'failed' ? 'failed' : 'succeeded',
      address: result.address,
      success: result.success,
      message: result.message,
      superseded,
    }
  }

  private finishCancelledTest(
    controller: AbortController,
    address: string,
  ): ConnectionTestOutcome {
    if (this.testController === controller) {
      this.testController = null
      this.state = {
        ...this.state,
        test: {
          ...this.state.test,
          phase: 'cancelled',
          success: false,
          message: null,
          error: null,
        },
      }
      this.notify()
    }
    return this.cancelledTestOutcome(address)
  }

  private cancelledTestOutcome(address: string): ConnectionTestOutcome {
    return {
      status: 'cancelled',
      address,
      success: false,
      message: null,
      superseded: false,
    }
  }

  private abortDiscovery(): void {
    const controller = this.discoveryController
    this.discoveryController = null
    controller?.abort()
  }

  private abortTest(): void {
    const controller = this.testController
    this.testController = null
    controller?.abort()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export const settingsDeviceConnectionOwner = new DeviceConnectionOwner()
