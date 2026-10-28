import { execFile, spawn } from 'child_process'
import { closeSync, openSync } from 'fs'
import { promisify } from 'util'
import path from 'path'
import { setTimeout as delay } from 'timers/promises'
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.js'
import { getWebrtcHostIp, getWebrtcRuntimeBinary, installWebrtcRelease } from './webrtcRuntime.js'

const execFileAsync = promisify(execFile)

export { DEFAULT_ADB_PATH }

const WEBRTC_DIR = process.env.LA_PLUMA_WEBRTC_DIR || `${process.env.HOME || ''}/ScrcpyOverWebRTC`
export const WEBRTC_PORT = Number(process.env.LA_PLUMA_WEBRTC_PORT || 8443)
const WEBRTC_TURN_PORT = Number(process.env.LA_PLUMA_WEBRTC_TURN_PORT || 3478)
export const DEFAULT_DEVICE_ADDRESS = DEFAULT_ADB_ADDRESS
export const DEFAULT_DEVICE_ID = 'mumu-la-pluma'

const WEBRTC_REQUEST_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_REQUEST_TIMEOUT_MS, 1500)
const WEBRTC_SERVER_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_SERVER_START_TIMEOUT_MS, 15000)
const WEBRTC_AGENT_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_AGENT_START_TIMEOUT_MS, 20000)
const WEBRTC_TURN_START_TIMEOUT_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_TURN_START_TIMEOUT_MS, 5000)
const WEBRTC_START_POLL_INTERVAL_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_START_POLL_INTERVAL_MS, 250)
const WEBRTC_VIEWER_IDLE_GRACE_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS, 3000)
const WEBRTC_VIEWER_STARTUP_GRACE_MS = readPositiveInteger(process.env.LA_PLUMA_WEBRTC_VIEWER_STARTUP_GRACE_MS, 15000)
const WEBRTC_USERNAME = process.env.LA_PLUMA_WEBRTC_USERNAME || 'admin'
const WEBRTC_PASSWORD = process.env.LA_PLUMA_WEBRTC_PASSWORD || 'admin123'

let webrtcServerProcess = null
let webrtcAgentProcess = null
let webrtcTurnProcess = null
let webrtcBuildProcess = null
let webrtcLifecycleQueue = Promise.resolve()
let registeredAgentOwner = null
let idleStoppedAgentOwner = null
let agentGeneration = 0
const processStartupErrors = new WeakMap()

// 预览运行时是进程级单例：关闭一旦开始，同一进程不再启动新的预览资源。
// closeAbort 用于取消关闭时仍在等待的启动/停止步骤，避免它们继续派生或占用资源。
let closeRequested = false
const closeAbort = new AbortController()
const attachedLifecycles = new WeakSet()
let attachedLifecycle = null

// Register before waiting on the lifecycle queue so a new browser prevents a
// queued idle stop. If stopping has already begun, its upgrade waits for restore.
const viewerLifecycle = createWebrtcViewerLifecycle({
  idleGraceMs: WEBRTC_VIEWER_IDLE_GRACE_MS,
  startupGraceMs: WEBRTC_VIEWER_STARTUP_GRACE_MS,
  releaseIdle: (deviceId, generation, isIdle) => enqueueLifecycle(
    () => stopIdleWebrtcAgentUnlocked(deviceId, generation, isIdle)
  ).catch(error => {
    // 关闭流程已取消的自动回收不再重试，也不再告警。
    if (error?.code === 'WEBRTC_PREVIEW_CLOSED') return { stopped: false, closed: true }
    throw error
  }),
  restore: deviceId => enqueueLifecycle(async () => {
    const owner = idleStoppedAgentOwner
    if (!owner || owner.deviceId !== deviceId) return
    if (registeredAgentOwner) return
    await startWebrtcAgentUnlocked(owner.address, owner.deviceId, owner.adbPath)
  })
})

export function createWebrtcViewerLifecycle({
  idleGraceMs = 3000,
  startupGraceMs = 15000,
  releaseIdle,
  restore = async () => {},
  onError = error => console.warn('[WebRTC] Idle preview cleanup failed:', error.message)
}) {
  const devices = new Map()
  const unscopedViewers = new Set()

  function getDevice(deviceId) {
    if (!devices.has(deviceId)) devices.set(deviceId, { viewers: new Set(), generation: null, timer: null })
    return devices.get(deviceId)
  }

  function cancelIdle(device) {
    if (device.timer) clearTimeout(device.timer)
    device.timer = null
  }

  function scheduleIdle(deviceId, device, graceMs) {
    cancelIdle(device)
    if (device.generation === null) {
      if (!device.viewers.size && devices.get(deviceId) === device) devices.delete(deviceId)
      return
    }
    if (device.viewers.size || unscopedViewers.size) return
    const generation = device.generation
    const isIdle = () => devices.get(deviceId) === device && device.generation === generation
      && !device.viewers.size && !unscopedViewers.size
    device.timer = setTimeout(() => {
      device.timer = null
      if (!isIdle()) return
      Promise.resolve().then(() => releaseIdle(deviceId, generation, isIdle)).then(result => {
        if (isIdle() && result?.retry) scheduleIdle(deviceId, device, idleGraceMs)
      }).catch(error => {
        onError(error)
        if (isIdle()) scheduleIdle(deviceId, device, idleGraceMs)
      })
    }, graceMs)
    device.timer.unref?.()
  }

  return {
    started(deviceId, generation) {
      const device = getDevice(deviceId)
      device.generation = generation
      scheduleIdle(deviceId, device, startupGraceMs)
    },
    stopped(deviceId) {
      const device = devices.get(deviceId)
      if (!device) return
      cancelIdle(device)
      device.generation = null
      if (!device.viewers.size) devices.delete(deviceId)
    },
    retain(deviceId) {
      const token = {}
      const device = deviceId ? getDevice(deviceId) : null
      const viewers = device?.viewers || unscopedViewers
      viewers.add(token)
      if (device) cancelIdle(device)
      else for (const entry of devices.values()) cancelIdle(entry)
      let released = false
      return {
        ready: deviceId ? restore(deviceId) : Promise.resolve(),
        release() {
          if (released) return
          released = true
          viewers.delete(token)
          if (device) scheduleIdle(deviceId, device, idleGraceMs)
          else for (const [id, entry] of devices) scheduleIdle(id, entry, idleGraceMs)
        }
      }
    },
    close() {
      for (const device of devices.values()) cancelIdle(device)
      devices.clear()
      unscopedViewers.clear()
    }
  }
}

export function registerWebrtcViewer(deviceId) {
  return viewerLifecycle.retain(deviceId)
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function previewClosedError(cause) {
  const error = new Error('WebRTC 预览运行时已进入关闭流程，操作已取消')
  error.code = 'WEBRTC_PREVIEW_CLOSED'
  error.retryable = false
  if (cause) error.cause = cause
  return error
}

function assertPreviewOpen() {
  if (closeRequested) throw previewClosedError()
  // 运行时关闭流程进入 draining 后，排队中的启动/停止不再开始。
  if (attachedLifecycle?.isDraining?.()) throw previewClosedError()
}

function getCloseSignal() {
  return closeAbort.signal
}

function enqueueLifecycle(operation) {
  const run = () => {
    // 关闭请求可能在操作排队后到达：排队中的启动/停止不能再触碰新资源。
    assertPreviewOpen()
    return operation()
  }
  const pending = webrtcLifecycleQueue.then(run, run)
  webrtcLifecycleQueue = pending.then(() => undefined, () => undefined)
  return pending
}

function isChildProcessRunning(child) {
  return Boolean(child && !child.killed && child.exitCode === null && child.signalCode === null)
}

function terminateManagedProcess(child) {
  if (!isChildProcessRunning(child)) return
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Fall back when the child did not establish its process group.
    }
  }
  child.kill('SIGTERM')
}

function clearManagedProcess(type, child) {
  if (type === 'server' && webrtcServerProcess === child) webrtcServerProcess = null
  if (type === 'agent' && webrtcAgentProcess === child) webrtcAgentProcess = null
  if (type === 'turn' && webrtcTurnProcess === child) webrtcTurnProcess = null
}

function trackManagedProcess(child, type) {
  child.once('error', error => {
    processStartupErrors.set(child, error)
    clearManagedProcess(type, child)
  })
  child.once('exit', () => clearManagedProcess(type, child))
  return child
}

function spawnWithLog(command, args, logPath, options) {
  const logFd = openSync(logPath, 'a')
  try {
    return spawn(command, args, {
      ...options,
      stdio: ['ignore', logFd, logFd]
    })
  } finally {
    closeSync(logFd)
  }
}

function processStartupFailure(child, label, { allowSuccessfulExit = false } = {}) {
  if (!child) return null
  const spawnError = processStartupErrors.get(child)
  if (spawnError) {
    const error = new Error(`${label}进程启动失败：${spawnError.message}`)
    error.code = 'WEBRTC_PROCESS_START_FAILED'
    error.retryable = false
    return error
  }
  if (child.signalCode !== null || (child.exitCode !== null && (!allowSuccessfulExit || child.exitCode !== 0))) {
    const reason = child.signalCode ? `信号 ${child.signalCode}` : `退出码 ${child.exitCode}`
    const error = new Error(`${label}进程在就绪前退出（${reason}）`)
    error.code = 'WEBRTC_PROCESS_EXITED'
    error.retryable = false
    return error
  }
  return null
}

export async function waitForCondition(check, {
  timeoutMs,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  timeoutMessage,
  timeoutCode = 'WEBRTC_START_TIMEOUT',
  signal = null
}) {
  const startedAt = Date.now()
  let lastError = null

  while (true) {
    if (signal?.aborted) throw previewClosedError()
    try {
      const result = await check()
      if (result) {
        if (signal?.aborted) throw previewClosedError()
        return result
      }
      lastError = null
    } catch (error) {
      if (signal?.aborted) throw previewClosedError(error)
      if (error?.retryable === false) throw error
      lastError = error
    }

    const elapsed = Date.now() - startedAt
    if (elapsed >= timeoutMs) {
      const detail = lastError?.message ? `；最后一次检查失败：${lastError.message}` : ''
      const error = new Error(`${timeoutMessage}${detail}`)
      error.code = timeoutCode
      if (lastError) error.cause = lastError
      throw error
    }
    const waitMs = Math.min(pollIntervalMs, timeoutMs - elapsed)
    if (!signal) {
      await delay(waitMs)
      continue
    }
    try {
      await delay(waitMs, undefined, { signal })
    } catch (error) {
      if (signal.aborted) throw previewClosedError(error)
      throw error
    }
  }
}

async function execFileQuiet(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { timeout: 5000, ...options })
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', error }
  }
}

export function parseAdbDeviceState(devicesOutput, address) {
  for (const line of String(devicesOutput || '').split(/\r?\n/)) {
    const [serial, state] = line.trim().split(/\s+/)
    if (serial === address) return state || null
  }
  return null
}

async function readAdbDeviceState(address, adbPath) {
  const { stdout, error } = await execFileQuiet(adbPath, ['devices'], { timeout: 5000 })
  if (error) {
    const commandError = new Error(`无法执行 ADB：${error.message}`)
    commandError.code = error.code === 'ENOENT' ? 'WEBRTC_ADB_NOT_FOUND' : 'WEBRTC_ADB_COMMAND_FAILED'
    commandError.retryable = error.code !== 'ENOENT'
    throw commandError
  }
  return parseAdbDeviceState(stdout, address)
}

export async function waitForAdbDeviceReady(address, adbPath, {
  timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  getDeviceState = () => readAdbDeviceState(address, adbPath),
  signal = null
} = {}) {
  let lastState = null
  try {
    return await waitForCondition(async () => {
      lastState = await getDeviceState()
      return lastState === 'device' ? lastState : false
    }, {
      timeoutMs,
      pollIntervalMs,
      signal,
      timeoutMessage: `等待 ADB 设备就绪超时（${timeoutMs}ms）：${address}`,
      timeoutCode: 'WEBRTC_ADB_READY_TIMEOUT'
    })
  } catch (error) {
    if (error?.code !== 'WEBRTC_ADB_READY_TIMEOUT') throw error

    const stateMessages = {
      offline: `ADB 设备离线：${address}`,
      unauthorized: `ADB 设备未授权：${address}，请在设备上允许调试`,
      no_permissions: `ADB 无权访问设备：${address}`
    }
    const readinessError = new Error(stateMessages[lastState] || `ADB 中未找到目标设备：${address}`)
    readinessError.code = lastState === 'offline'
      ? 'WEBRTC_ADB_DEVICE_OFFLINE'
      : lastState === 'unauthorized'
        ? 'WEBRTC_ADB_DEVICE_UNAUTHORIZED'
        : lastState === 'no_permissions'
          ? 'WEBRTC_ADB_DEVICE_FORBIDDEN'
          : 'WEBRTC_ADB_DEVICE_NOT_FOUND'
    readinessError.retryable = true
    readinessError.cause = error
    throw readinessError
  }
}

async function getListeningPidsOnTcpPort(port) {
  const { stdout } = await execFileQuiet('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return stdout.trim().split(/\s+/).filter(Boolean)
}

async function isProcessListeningOnTcpPort(port) {
  return (await getListeningPidsOnTcpPort(port)).length > 0
}

export async function pathExists(filePath) {
  const fs = await import('fs/promises')
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function getWebrtcBinaryPath() {
  return getWebrtcRuntimeBinary(WEBRTC_DIR)
}

export async function getWebrtcAssetsPath() {
  const legacyAssetsPath = path.join(WEBRTC_DIR, 'assets', 'v1')
  if (await pathExists(legacyAssetsPath)) return legacyAssetsPath

  const releaseAssetsPath = path.join(WEBRTC_DIR, 'assets')
  if (await pathExists(path.join(releaseAssetsPath, 'index.html'))) return releaseAssetsPath

  return null
}

export async function getWebrtcLogPaths() {
  return {
    serverLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-server.log'),
    agentLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-agent.log'),
    turnLog: path.join(WEBRTC_DIR, 'la-pluma-webrtc-turn.log')
  }
}

export async function isWebrtcServerReachable() {
  try {
    const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}`, {
      signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

async function requestWebrtcAuthToken() {
  const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: WEBRTC_USERNAME, password: WEBRTC_PASSWORD }),
    signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`WebRTC 登录失败（HTTP ${response.status}）`)
  }
  const data = await response.json()
  if (!data?.token) throw new Error('WebRTC 登录响应缺少 token')
  return data.token
}

export async function getWebrtcAuthToken({ throwOnError = false } = {}) {
  try {
    return await requestWebrtcAuthToken()
  } catch (error) {
    if (throwOnError) throw error
    return ''
  }
}

function normalizeDeviceIds(data) {
  if (!Array.isArray(data)) throw new Error('WebRTC /devices 响应格式无效')
  return data
    .map(item => typeof item === 'string' ? item : (item?.device_id || item?.id))
    .filter(Boolean)
}

async function requestWebrtcDeviceDetails() {
  const token = await requestWebrtcAuthToken()
  const response = await fetch(`http://127.0.0.1:${WEBRTC_PORT}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(WEBRTC_REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`WebRTC 设备列表请求失败（HTTP ${response.status}）`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error('WebRTC /devices 响应格式无效')
  return data
}

export async function getWebrtcDevices({ throwOnError = false } = {}) {
  try {
    return normalizeDeviceIds(await requestWebrtcDeviceDetails())
  } catch (error) {
    if (throwOnError) throw error
    return []
  }
}

export async function waitForWebrtcServerReady({
  timeoutMs = WEBRTC_SERVER_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  isReachable = isWebrtcServerReachable,
  childProcess = null,
  signal = null
} = {}) {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'WebRTC 服务')
    if (failure) throw failure
    return isReachable()
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC 服务启动超时（${timeoutMs}ms）：http://127.0.0.1:${WEBRTC_PORT} 未就绪`,
    timeoutCode: 'WEBRTC_SERVER_START_TIMEOUT'
  })
}

export async function waitForTurnServerReady({
  timeoutMs = WEBRTC_TURN_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  isListening = () => isProcessListeningOnTcpPort(WEBRTC_TURN_PORT),
  childProcess = null,
  signal = null
} = {}) {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'TURN 服务')
    if (failure) throw failure
    return isListening()
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `TURN 服务启动超时（${timeoutMs}ms）：127.0.0.1:${WEBRTC_TURN_PORT} 未监听`,
    timeoutCode: 'WEBRTC_TURN_START_TIMEOUT'
  })
}

async function waitForWebrtcDevicesApi({
  timeoutMs = WEBRTC_SERVER_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  signal = null
} = {}) {
  const result = await waitForCondition(async () => ({
    devices: await getWebrtcDevices({ throwOnError: true })
  }), {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC 鉴权设备接口启动超时（${timeoutMs}ms）：/devices 未就绪`,
    timeoutCode: 'WEBRTC_DEVICES_API_TIMEOUT'
  })
  return result.devices
}

export async function waitForWebrtcDevice(deviceId, {
  timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  getDevices = () => getWebrtcDevices({ throwOnError: true }),
  childProcess = null,
  isAgentRunning = null,
  signal = null
} = {}) {
  return waitForCondition(async () => {
    const failure = processStartupFailure(childProcess, 'WebRTC Agent 部署', { allowSuccessfulExit: true })
    if (failure) throw failure
    if (childProcess && childProcess.exitCode !== 0) return false
    if (childProcess?.exitCode === 0 && isAgentRunning && !await isAgentRunning()) {
      const error = new Error('WebRTC Agent 部署脚本已结束，但设备端进程未启动')
      error.code = 'WEBRTC_AGENT_DEPLOYMENT_FAILED'
      error.retryable = true
      throw error
    }
    const devices = await getDevices()
    if (!devices.includes(deviceId)) return false
    if (isAgentRunning && !await isAgentRunning()) return false
    return devices
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC Agent 启动超时（${timeoutMs}ms）：设备 ${deviceId} 未出现在鉴权 /devices 列表中`,
    timeoutCode: 'WEBRTC_AGENT_START_TIMEOUT'
  })
}

async function waitForWebrtcDeviceUnavailable(deviceId, {
  timeoutMs = WEBRTC_AGENT_START_TIMEOUT_MS,
  pollIntervalMs = WEBRTC_START_POLL_INTERVAL_MS,
  signal = null
} = {}) {
  return waitForCondition(async () => {
    const devices = await getWebrtcDevices({ throwOnError: true })
    return devices.includes(deviceId) ? false : devices
  }, {
    timeoutMs,
    pollIntervalMs,
    signal,
    timeoutMessage: `WebRTC Agent 停止超时（${timeoutMs}ms）：设备 ${deviceId} 仍在鉴权 /devices 列表中`,
    timeoutCode: 'WEBRTC_AGENT_STOP_TIMEOUT'
  })
}

async function isDeviceAgentRunning(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'ps -A | grep cloudphone-agent || true'], { timeout: 5000 })
    return stdout.includes('cloudphone-agent')
  } catch {
    return false
  }
}

async function getIceServersConfig(address = DEFAULT_DEVICE_ADDRESS, turnListening) {
  if (process.env.LA_PLUMA_WEBRTC_ICE_SERVERS !== undefined) return process.env.LA_PLUMA_WEBRTC_ICE_SERVERS
  if (!(turnListening ?? await isProcessListeningOnTcpPort(WEBRTC_TURN_PORT))) return ''
  const lanIp = getWebrtcHostIp(address)
  return `turn:cloudphone_user:cloudphone_secure_password@${lanIp}:${WEBRTC_TURN_PORT}?transport=udp,stun:${lanIp}:${WEBRTC_TURN_PORT}`
}

function isSameAgentOwner(owner, address, deviceId) {
  return owner?.address === address && owner?.deviceId === deviceId
}

async function stopRemoteWebrtcAgent(address, adbPath, { signal } = {}) {
  const killRemote = command => execFileAsync(adbPath, ['-s', address, 'shell', command], {
    timeout: 5000,
    signal
  }).catch(() => {})
  await killRemote('pkill -f cloudphone-agent || true')
  await killRemote('pkill -f com.android.helper.CoreService || true')
  await killRemote('pkill -f scrcpy.Server || true')
}

async function startLocalTurnServerUnlocked() {
  const signal = getCloseSignal()
  assertPreviewOpen()
  if (await isProcessListeningOnTcpPort(WEBRTC_TURN_PORT)) return
  let child = isChildProcessRunning(webrtcTurnProcess) ? webrtcTurnProcess : null
  if (!child) {
    const configuredTurnServer = process.env.LA_PLUMA_WEBRTC_TURN_SERVER_PATH?.trim()
    const turnserver = configuredTurnServer
      ? [configuredTurnServer]
      : ['/usr/bin/turnserver', '/usr/local/bin/turnserver', '/opt/homebrew/bin/turnserver']
    let turnserverPath = null
    for (const candidate of turnserver) {
      if (await pathExists(candidate)) {
        turnserverPath = candidate
        break
      }
    }
    if (!turnserverPath) return
    const { turnLog } = await getWebrtcLogPaths()
    assertPreviewOpen()
    child = spawnWithLog(turnserverPath, [
      '-n',
      '--no-cli',
      '--no-tls',
      '--no-dtls',
      '-L', '0.0.0.0',
      '-p', String(WEBRTC_TURN_PORT),
      '-a',
      '-u', 'cloudphone_user:cloudphone_secure_password',
      '-r', 'cloudphone'
    ], turnLog, {
      cwd: WEBRTC_DIR,
      detached: false
    })
    webrtcTurnProcess = trackManagedProcess(child, 'turn')
  }
  try {
    await waitForTurnServerReady({ childProcess: child, signal })
  } catch (error) {
    if (isChildProcessRunning(child)) child.kill('SIGTERM')
    clearManagedProcess('turn', child)
    throw error
  }
}

function terminateOwnedLocalProcesses() {
  terminateManagedProcess(webrtcBuildProcess)
  terminateManagedProcess(webrtcAgentProcess)
  terminateManagedProcess(webrtcServerProcess)
  terminateManagedProcess(webrtcTurnProcess)
  webrtcBuildProcess = null
  webrtcAgentProcess = null
  webrtcServerProcess = null
  webrtcTurnProcess = null
}

/**
 * 只释放本实例启动的预览资源：本进程的本地子进程，以及登记了所有权的设备端 Agent。
 * 启动前已存在的 server/TURN 与设备端 Agent 没有所有权记录，保持不动。
 */
async function releaseOwnedPreviewResourcesUnlocked({ stopDeviceAgent = false } = {}) {
  const owner = registeredAgentOwner
  const released = []
  idleStoppedAgentOwner = null
  if (owner) viewerLifecycle.stopped(owner.deviceId)
  if (isChildProcessRunning(webrtcAgentProcess)) released.push('agent-deployment')
  if (isChildProcessRunning(webrtcServerProcess)) released.push('server')
  if (isChildProcessRunning(webrtcTurnProcess)) released.push('turn')
  terminateOwnedLocalProcesses()
  registeredAgentOwner = null
  if (stopDeviceAgent && owner) {
    await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() })
    released.push('device-agent')
  }
  return released
}

export async function getWebrtcStatus(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  const binaryPath = await getWebrtcBinaryPath()
  const assetsPath = await getWebrtcAssetsPath()
  const lanIp = getWebrtcHostIp(address)
  const logPaths = await getWebrtcLogPaths()
  const [serverReachable, turnListening, deviceAgentRunning] = await Promise.all([
    isWebrtcServerReachable(),
    isProcessListeningOnTcpPort(WEBRTC_TURN_PORT),
    isDeviceAgentRunning(address, adbPath)
  ])
  const serverManaged = isChildProcessRunning(webrtcServerProcess)
  const turnManaged = isChildProcessRunning(webrtcTurnProcess)
  const agentRunning = isChildProcessRunning(webrtcAgentProcess) || deviceAgentRunning
  const agentManaged = Boolean(registeredAgentOwner) && registeredAgentOwner.address === address
  return {
    installed: await pathExists(WEBRTC_DIR),
    built: await pathExists(binaryPath) && assetsPath !== null,
    dir: WEBRTC_DIR,
    port: WEBRTC_PORT,
    url: `http://127.0.0.1:${WEBRTC_PORT}`,
    lanUrl: `http://${lanIp}:${WEBRTC_PORT}`,
    signalingUrl: '/webrtc-signaling',
    directSignalingUrl: `ws://${lanIp}:${WEBRTC_PORT}`,
    turnRunning: turnManaged,
    iceServers: await getIceServersConfig(address, turnListening),
    serverRunning: serverManaged || serverReachable,
    agentRunning,
    // 所有权与“是否运行”分开：managed 由本实例启动/登记，external 是启动前已存在或其它实例的资源。
    ownership: {
      server: serverManaged ? 'managed' : (serverReachable ? 'external' : 'none'),
      turn: turnManaged ? 'managed' : (turnListening ? 'external' : 'none'),
      agent: agentManaged && agentRunning ? 'managed' : (agentRunning ? 'external' : 'none')
    },
    deviceAddress: address,
    ...logPaths
  }
}

async function installWebrtcUnlocked() {
  const signal = getCloseSignal()
  assertPreviewOpen()
  const fs = await import('fs/promises')

  const binaryPath = await getWebrtcBinaryPath()
  const assetsPath = await getWebrtcAssetsPath()
  if (await pathExists(binaryPath) && assetsPath && await pathExists(path.join(WEBRTC_DIR, 'agentd', 'run.sh'))) {
    return getWebrtcStatus()
  }

  const buildScript = path.join(WEBRTC_DIR, 'build.sh')
  if (!await pathExists(buildScript)) {
    try {
      await installWebrtcRelease(WEBRTC_DIR, { signal })
    } catch (error) {
      if (signal.aborted) throw previewClosedError(error)
      throw error
    }
    const status = await getWebrtcStatus()
    if (!status.built) throw new Error('WebRTC 发布包安装完成，但运行资源不完整')
    return status
  }

  await fs.chmod(buildScript, 0o755)
  assertPreviewOpen()
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [buildScript], { cwd: WEBRTC_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    webrtcBuildProcess = child
    const abortBuild = () => terminateManagedProcess(child)
    // 关闭流程会终止本实例启动的构建子进程，避免它成为无人回收的孤儿。
    signal.addEventListener('abort', abortBuild, { once: true })
    const finish = () => {
      signal.removeEventListener('abort', abortBuild)
      if (webrtcBuildProcess === child) webrtcBuildProcess = null
    }
    const appendOutput = chunk => {
      output = `${output}${chunk}`.slice(-4000)
    }
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    child.on('close', code => {
      finish()
      if (signal.aborted) {
        reject(previewClosedError())
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const detail = output.trim()
      const error = new Error(`build.sh 失败（退出码 ${code}）${detail ? `：${detail}` : ''}`)
      error.code = 'WEBRTC_BUILD_FAILED'
      error.exitCode = code
      error.retryable = false
      reject(error)
    })
    child.on('error', error => {
      finish()
      reject(signal.aborted ? previewClosedError(error) : error)
    })
  })

  const status = await getWebrtcStatus()
  if (!status.built) {
    const error = new Error('build.sh 已完成，但未找到 WebRTC 可执行文件或静态资源')
    error.code = 'WEBRTC_BUILD_OUTPUT_MISSING'
    error.retryable = false
    throw error
  }
  return status
}

export async function installWebrtc() {
  return enqueueLifecycle(installWebrtcUnlocked)
}

async function startWebrtcServerUnlocked(address, adbPath) {
  const signal = getCloseSignal()
  assertPreviewOpen()
  if (await isWebrtcServerReachable()) {
    return getWebrtcStatus(address, adbPath)
  }
  assertPreviewOpen()

  let child = webrtcServerProcess
  let spawned = false
  if (!isChildProcessRunning(child)) {
    const binaryPath = await getWebrtcBinaryPath()
    const assetsPath = await getWebrtcAssetsPath()
    if (!await pathExists(binaryPath) || !assetsPath) {
      throw new Error('WebRTC 组件未安装或未构建')
    }

    await startLocalTurnServerUnlocked()
    const { serverLog } = await getWebrtcLogPaths()
    const iceServers = await getIceServersConfig(address)
    assertPreviewOpen()
    child = spawnWithLog(binaryPath, ['-host', '0.0.0.0', '-port', String(WEBRTC_PORT), '-assets', assetsPath, '-ice_servers', iceServers, '-tls=false'], serverLog, {
      cwd: WEBRTC_DIR,
      detached: false,
      env: { ...process.env, PORT: String(WEBRTC_PORT), PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }
    })
    webrtcServerProcess = trackManagedProcess(child, 'server')
    spawned = true
  }

  try {
    await waitForWebrtcServerReady({ childProcess: child, signal })
  } catch (error) {
    if (spawned && isChildProcessRunning(child)) child.kill('SIGTERM')
    clearManagedProcess('server', child)
    throw error
  }
  return getWebrtcStatus(address, adbPath)
}

export async function startWebrtcServer(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(() => startWebrtcServerUnlocked(address, adbPath))
}

async function stopWebrtcServerUnlocked(address, adbPath) {
  const released = await releaseOwnedPreviewResourcesUnlocked({ stopDeviceAgent: true })
  const status = await getWebrtcStatus(address, adbPath)
  return { ...status, released }
}

export async function stopWebrtcServer(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(() => stopWebrtcServerUnlocked(address, adbPath))
}

async function startWebrtcAgentUnlocked(address, deviceId, adbPath) {
  const signal = getCloseSignal()
  idleStoppedAgentOwner = null
  assertPreviewOpen()
  await waitForWebrtcServerReady({ signal })
  const onlineDevices = await waitForWebrtcDevicesApi({ signal })
  const currentOwner = registeredAgentOwner
  if (isSameAgentOwner(currentOwner, address, deviceId)
    && onlineDevices.includes(deviceId)
    && await isDeviceAgentRunning(address, adbPath)) {
    assertPreviewOpen()
    registeredAgentOwner = { address, deviceId, adbPath, generation: ++agentGeneration }
    viewerLifecycle.started(deviceId, registeredAgentOwner.generation)
    return { ...await getWebrtcStatus(address, adbPath), agentRunning: true }
  }

  if (/^[^:]+:\d+$/.test(address)) {
    assertPreviewOpen()
    await execFileQuiet(adbPath, ['connect', address], { timeout: 5000 })
  }
  await waitForAdbDeviceReady(address, adbPath, { signal })

  if (currentOwner) {
    registeredAgentOwner = null
    viewerLifecycle.stopped(currentOwner.deviceId)
    await stopRemoteWebrtcAgent(currentOwner.address, currentOwner.adbPath, { signal })
    await waitForWebrtcDeviceUnavailable(currentOwner.deviceId, { signal })
  }

  const runScript = path.join(WEBRTC_DIR, 'agentd', 'run.sh')
  if (!await pathExists(runScript)) {
    throw new Error('WebRTC agent 未安装')
  }

  const { agentLog } = await getWebrtcLogPaths()
  const lanIp = getWebrtcHostIp(address)
  const iceServers = await getIceServersConfig(address)
  assertPreviewOpen()
  const child = spawnWithLog('bash', [runScript, address, '-id', deviceId, '-signaling', `ws://${lanIp}:${WEBRTC_PORT}`, '-ice-servers', iceServers, '-webrtc-port', '50000'], agentLog, {
    cwd: path.join(WEBRTC_DIR, 'agentd'),
    detached: true,
    env: { ...process.env, ADB_PATH: adbPath, PATH: `${path.dirname(adbPath)}:${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
  })
  webrtcAgentProcess = trackManagedProcess(child, 'agent')
  try {
    await waitForWebrtcDevice(deviceId, {
      childProcess: child,
      isAgentRunning: () => isDeviceAgentRunning(address, adbPath),
      signal
    })
    registeredAgentOwner = { address, deviceId, adbPath, generation: ++agentGeneration }
    viewerLifecycle.started(deviceId, registeredAgentOwner.generation)
    return { ...await getWebrtcStatus(address, adbPath), agentRunning: true }
  } catch (error) {
    terminateManagedProcess(child)
    clearManagedProcess('agent', child)
    if (isSameAgentOwner(registeredAgentOwner, address, deviceId)) registeredAgentOwner = null
    await stopRemoteWebrtcAgent(address, adbPath, { signal })
    throw error
  }
}

export async function startWebrtcAgent(address = DEFAULT_DEVICE_ADDRESS, deviceId = DEFAULT_DEVICE_ID, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(() => startWebrtcAgentUnlocked(address, deviceId, adbPath))
}

async function stopWebrtcAgentUnlocked(address, adbPath) {
  const owner = registeredAgentOwner
  const released = []
  idleStoppedAgentOwner = null
  if (owner) viewerLifecycle.stopped(owner.deviceId)
  if (isChildProcessRunning(webrtcAgentProcess)) released.push('agent-deployment')
  terminateManagedProcess(webrtcAgentProcess)
  webrtcAgentProcess = null
  registeredAgentOwner = null
  if (owner) {
    await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() })
    released.push('device-agent')
  }
  const status = await getWebrtcStatus(address, adbPath)
  return { ...status, released }
}

export async function stopWebrtcAgent(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(() => stopWebrtcAgentUnlocked(address, adbPath))
}

async function stopIdleWebrtcAgentUnlocked(deviceId, generation, isIdle) {
  const owner = registeredAgentOwner
  if (!owner || owner.deviceId !== deviceId || owner.generation !== generation || !isIdle()) return

  // The upstream service also knows about viewers connected directly to its
  // listener. Older releases return string IDs only; those use gateway counts.
  const devices = await requestWebrtcDeviceDetails()
  const device = devices.find(entry => entry && typeof entry === 'object'
    && (entry.device_id || entry.id) === deviceId)
  if (device && (Number(device.client_count) > 0 || device.clients?.length > 0)) return { retry: true }
  if (!isIdle() || registeredAgentOwner !== owner) return

  terminateManagedProcess(webrtcAgentProcess)
  webrtcAgentProcess = null
  await stopRemoteWebrtcAgent(owner.address, owner.adbPath, { signal: getCloseSignal() })
  if (registeredAgentOwner === owner) registeredAgentOwner = null
  idleStoppedAgentOwner = owner
  viewerLifecycle.stopped(deviceId)
  return { stopped: true }
}

async function closeWebrtcPreview() {
  closeRequested = true
  if (!closeAbort.signal.aborted) closeAbort.abort()
  // 先取消 viewer 自动回收计时器，再终止本进程拥有的子进程；
  // 已受理的启动/停止会因 abort 立即结束，等待队列后做一次兜底终止。
  viewerLifecycle.close()
  terminateOwnedLocalProcesses()
  await webrtcLifecycleQueue
  terminateOwnedLocalProcesses()
  idleStoppedAgentOwner = null
  registeredAgentOwner = null
  return { stopped: true }
}

/**
 * 把预览资源释放注册到运行时关闭流程；同一 lifecycle 只注册一次。
 *
 * 关闭只处理本实例启动或登记所有权的资源：viewer 计时器/会话、
 * 本进程的信号服务/TURN/Agent 部署/构建子进程。启动前已存在的
 * server/TURN 与设备端 Agent 没有所有权记录，不在此流程内。
 */
export function attachWebrtcPreviewToLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle.register !== 'function') {
    return { attached: false, duplicate: false }
  }
  if (attachedLifecycles.has(lifecycle)) {
    return { attached: true, duplicate: true }
  }
  lifecycle.register({
    name: 'webrtc-preview',
    close: () => closeWebrtcPreview()
  })
  attachedLifecycles.add(lifecycle)
  attachedLifecycle = lifecycle
  return { attached: true, duplicate: false }
}

export async function startWebrtc(address = DEFAULT_DEVICE_ADDRESS, deviceId = DEFAULT_DEVICE_ID, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(async () => {
    await startWebrtcServerUnlocked(address, adbPath)
    return startWebrtcAgentUnlocked(address, deviceId, adbPath)
  })
}

export async function stopWebrtc(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  return enqueueLifecycle(async () => {
    const released = []
    const agentResult = await stopWebrtcAgentUnlocked(address, adbPath).catch(() => null)
    if (agentResult?.released) released.push(...agentResult.released)
    const serverResult = await stopWebrtcServerUnlocked(address, adbPath).catch(() => null)
    if (serverResult?.released) released.push(...serverResult.released)
    return { stopped: true, released: [...new Set(released)] }
  })
}
