import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.js';

/**
 * ADB 设备探测、连接测试、游戏前台状态与截图。
 *
 * - ADB 路径与地址在进入子进程前统一校验，拒绝 shell 元字符与非法地址；
 *   截图按步骤设置超时并在超时时发送 SIGKILL。
 * - 设备发现只返回候选，不自动连接；候选与内置 ADB 的合并顺序保持既有
 *   契约（同名 serial 优先采用当前配置的 ADB 结果）。
 * - 这里不持有任务状态、执行租约或 Run 终态；设备变更权仍由执行租约决定，
 *   本模块只读设备事实。
 */

const execFilePromise = promisify(execFile);

const logger = createLogger('MaaService');

const LOCAL_EMULATOR_ADDRESSES: readonly string[] = [
  '127.0.0.1:16384',
  '127.0.0.1:5555',
  '127.0.0.1:7555',
  '127.0.0.1:62001',
  '127.0.0.1:21503'
];
const WINDOWS_EMULATOR_PROCESSES = [
  { names: ['HD-Player.exe'], label: 'BlueStacks', adbFiles: ['HD-Adb.exe', 'adb.exe'] },
  { names: ['dnplayer.exe'], label: 'LDPlayer', adbFiles: ['adb.exe'] },
  { names: ['Nox.exe', 'NoxVMHandle.exe'], label: '夜神模拟器', adbFiles: ['nox_adb.exe', 'adb.exe'] },
  { names: ['MuMuPlayer.exe', 'MuMuNxDevice.exe'], label: 'MuMu 模拟器', adbFiles: ['adb.exe', 'shell\\adb.exe'] },
  { names: ['MEmu.exe', 'MEmuHeadless.exe'], label: '逍遥模拟器', adbFiles: ['adb.exe', 'MEmuHyperv\\adb.exe'] }
] as const;
const GAME_PACKAGES: Readonly<Record<string, string>> = {
  Official: 'com.hypergryph.arknights',
  Bilibili: 'com.hypergryph.arknights.bilibili',
  YoStarEN: 'com.YoStarEN.Arknights',
  YoStarJP: 'com.YoStarJP.Arknights',
  YoStarKR: 'com.YoStarKR.Arknights',
  Txwy: 'tw.txwy.and.arknights'
};

/** adb devices 报告的连接状态；未知状态不能当作可用。 */
export type AdbDeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown';

/** 设备来源：当前 ADB、模拟器内置 ADB 或本机端口候选。 */
export type AdbDeviceSource = 'adb' | 'emulator-adb' | 'local-port';

/** 设备发现条目；候选状态为 `candidate`，不会被自动连接。 */
export interface AdbDevice {
  address: string;
  state: AdbDeviceState | 'candidate';
  details: string;
  source: AdbDeviceSource;
  adbPath?: string;
  label?: string;
}

/** 模拟器内置 ADB 的安装位置。 */
export interface AdbInstallation {
  adbPath: string;
  label: string;
  source: 'emulator-adb';
}

/** 设备发现结果；失败时 error 说明原因，设备列表为空。 */
export interface AdbDiscoveryResult {
  success: boolean;
  adbAvailable: boolean;
  message: string;
  devices: AdbDevice[];
  candidates: AdbDevice[];
  adbInstallations?: AdbInstallation[];
  error?: string;
}

/** 游戏前台状态；running 只在期望包位于前台时为 true。 */
export interface GameClientState {
  running: boolean;
  expectedPackage: string;
  foregroundPackage: string | null;
}

/** ADB 连接测试结果；connected 只在确认设备可用时给出。 */
export interface AdbConnectionResult {
  success: boolean;
  message: string;
  connected?: boolean;
  error?: string;
  output?: string;
}

/** 截图结果：base64 图像与采集时间。 */
export interface CapturedScreen {
  image: string;
  timestamp: string;
}

interface EmulatorProcess {
  name: string;
  executablePath: string;
}

interface AdbDeviceMetadata {
  adbPath?: string;
  label?: string;
  source?: AdbDeviceSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdbDeviceState(value: string): value is AdbDeviceState {
  return value === 'device' || value === 'offline' || value === 'unauthorized';
}

function validateAdbPath(adbPath: unknown): string {
  if (typeof adbPath !== 'string' || !adbPath.trim()) {
    throw new Error('ADB 路径不能为空');
  }
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/][^<>:"|?*\x00-\x1f]*$/.test(adbPath)) {
    return adbPath;
  }
  // 允许命令名或普通绝对/相对路径，拒绝 shell 元字符。
  if (!/^[\w@%+=:,./~-]+$/.test(adbPath)) {
    throw new Error('ADB 路径包含非法字符');
  }
  return adbPath;
}

function validateAdbAddress(address: unknown): string {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error('ADB 地址不能为空');
  }
  // 常见形态：127.0.0.1:5555、192.168.1.2:5555、localhost:5555、emulator-5554
  if (!/^([a-zA-Z0-9_.-]+)(:\d{1,5})?$/.test(address)) {
    throw new Error('ADB 地址格式不合法');
  }
  return address;
}

/** 文本命令端口：输出按 utf8 读取；路径在进入子进程前校验。 */
async function adbExecText(
  adbPath: unknown,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const executable = validateAdbPath(adbPath);
  return execFilePromise(executable, [...args], {
    maxBuffer: 50 * 1024 * 1024,
    ...options,
    encoding: 'utf8'
  });
}

/** 二进制命令端口：截图按 buffer 读取原图。 */
async function adbExecBuffer(
  adbPath: unknown,
  args: readonly string[],
  options: ExecFileOptions
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const executable = validateAdbPath(adbPath);
  return execFilePromise(executable, [...args], {
    maxBuffer: 50 * 1024 * 1024,
    ...options,
    encoding: 'buffer'
  });
}

function parseAdbDeviceList(output: unknown = ''): AdbDevice[] {
  return String(output)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices attached'))
    .map(line => {
      const [address = '', state = 'unknown', ...attributes] = line.split(/\s+/);
      const metadata = Object.fromEntries(attributes
        .map(attribute => attribute.split(':', 2))
        .filter(([key, value]) => key && value));
      const details = [metadata.model, metadata.device, metadata.product]
        .filter(Boolean)
        .map(value => value.replace(/_/g, ' '))
        .join(' · ');

      return {
        address,
        state: isAdbDeviceState(state) ? state : 'unknown',
        details: details || attributes.join(' '),
        source: 'adb'
      } satisfies AdbDevice;
    })
    .filter(device => device.address);
}

export function getAdbDeviceState(output: unknown, address: string): AdbDeviceState | null {
  const state = parseAdbDeviceList(output).find(device => device.address === address)?.state;
  return state && state !== 'candidate' ? state : null;
}

function probeLocalAddress(address: string, timeout = 280): Promise<boolean> {
  const [host, portValue] = address.split(':');
  const port = Number(portValue);
  if (!host || !Number.isInteger(port)) return Promise.resolve(false);

  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const complete = (reachable: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => complete(true));
    socket.once('timeout', () => complete(false));
    socket.once('error', () => complete(false));
  });
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function findWindowsEmulatorSpec(processName: unknown = ''): (typeof WINDOWS_EMULATOR_PROCESSES)[number] | undefined {
  const normalizedName = String(processName).toLowerCase();
  return WINDOWS_EMULATOR_PROCESSES.find(spec =>
    spec.names.some(name => name.toLowerCase() === normalizedName)
  );
}

async function getWindowsEmulatorProcesses(): Promise<EmulatorProcess[]> {
  if (process.platform !== 'win32') return [];

  const processFilter = WINDOWS_EMULATOR_PROCESSES
    .flatMap(spec => spec.names)
    .map(name => `Name='${name}'`)
    .join(' OR ');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Get-CimInstance Win32_Process -Filter \"${processFilter}\"`,
    'Select-Object Name, ExecutablePath',
    'ConvertTo-Json -Compress'
  ].join(' | ');

  try {
    const { stdout } = await execFilePromise('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ], { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const output = stdout.trim();
    if (!output) return [];
    const parsed: unknown = JSON.parse(output);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map(entry => {
        if (!isRecord(entry) || typeof entry.Name !== 'string' || !entry.Name) return null;
        if (typeof entry.ExecutablePath !== 'string' || !entry.ExecutablePath) return null;
        return { name: entry.Name, executablePath: entry.ExecutablePath };
      })
      .filter((entry): entry is EmulatorProcess => entry !== null);
  } catch (error) {
    logger.debug('Windows 模拟器进程扫描失败', { error: errorMessageOf(error) });
    return [];
  }
}

async function discoverWindowsEmulatorAdbs(): Promise<AdbInstallation[]> {
  const processes = await getWindowsEmulatorProcesses();
  const seenPaths = new Set<string>();
  const installations: AdbInstallation[] = [];

  for (const processInfo of processes) {
    const spec = findWindowsEmulatorSpec(processInfo.name);
    if (!spec) continue;

    // 模拟器进程可能在安装根目录或其 bin/shell 子目录中，检查两层即可避免扫描无关路径。
    const roots = [dirname(processInfo.executablePath), dirname(dirname(processInfo.executablePath))];
    for (const root of roots) {
      for (const adbFile of spec.adbFiles) {
        const adbPath = join(root, adbFile);
        const key = adbPath.toLowerCase();
        if (seenPaths.has(key) || !await isRegularFile(adbPath)) continue;
        seenPaths.add(key);
        installations.push({
          adbPath,
          label: spec.label,
          source: 'emulator-adb'
        });
      }
    }
  }

  return installations;
}

async function listDevicesFromAdb(adbPath: string, metadata: AdbDeviceMetadata = {}): Promise<AdbDevice[]> {
  try {
    const { stdout } = await adbExecText(adbPath, ['devices', '-l'], { timeout: 6000, windowsHide: true });
    return parseAdbDeviceList(stdout).map(device => ({
      ...device,
      adbPath,
      ...metadata,
      details: [
        metadata.source === 'emulator-adb' ? `${metadata.label} 内置 ADB` : '',
        device.details
      ].filter(Boolean).join(' · ')
    }));
  } catch (error) {
    logger.debug('读取模拟器内置 ADB 设备失败', { adbPath, error: errorMessageOf(error) });
    return [];
  }
}

function isAdbDevice(value: unknown): value is AdbDevice {
  return isRecord(value)
    && typeof value.address === 'string'
    && typeof value.state === 'string'
    && typeof value.details === 'string'
    && typeof value.source === 'string';
}

/**
 * 合并设备组。历史调用会把“设备组数组”整体作为一组传入，`flat()` 只展开
 * 一层，内层数组因此从未成为设备条目；类型化后按设备形状显式收窄，非设备
 * 条目被忽略，不会把数组写进设备列表。内置 ADB 设备未能实际并入是既有
 * 缺陷，修复需要独立任务与 Windows 证据，本项不改设备发现语义。
 */
function mergeDiscoveredDevices(...deviceGroups: readonly unknown[][]): AdbDevice[] {
  const devicesByAddress = new Map<string, AdbDevice>();
  for (const device of deviceGroups.flat()) {
    if (!isAdbDevice(device)) continue;
    const existing = devicesByAddress.get(device.address);
    // Preserve the configured ADB result when two servers report the same serial.
    if (!existing || (existing.source === 'emulator-adb' && device.source !== 'emulator-adb')) {
      devicesByAddress.set(device.address, device);
    }
  }
  return [...devicesByAddress.values()];
}

/**
 * Lists ADB-visible devices and reachable common local emulator ports.
 * On Windows, also locates ADB executables bundled with running emulators.
 * Candidates are not connected automatically; callers must confirm them.
 */
export async function discoverAdbDevices(adbPath: unknown = DEFAULT_ADB_PATH): Promise<AdbDiscoveryResult> {
  let configuredAdbAvailable = true;
  try {
    await adbExecText(adbPath, ['version']);
  } catch (error) {
    configuredAdbAvailable = false;
    logger.debug('当前 ADB 不可用，继续查找 Windows 模拟器内置 ADB', { adbPath, error: errorMessageOf(error) });
  }

  try {
    const emulatorAdbs = await discoverWindowsEmulatorAdbs();
    if (!configuredAdbAvailable && emulatorAdbs.length === 0) {
      return {
        success: false,
        adbAvailable: false,
        message: 'ADB 不可用，请检查 ADB 路径或启动模拟器后重试',
        devices: [],
        candidates: [],
        adbInstallations: [],
        error: '未找到可用的 ADB'
      };
    }

    let configuredDevices: AdbDevice[] = [];
    if (configuredAdbAvailable) {
      const configuredAdbPath = validateAdbPath(adbPath);
      configuredDevices = await listDevicesFromAdb(configuredAdbPath, {
        adbPath: configuredAdbPath,
        label: '当前 ADB',
        source: 'adb'
      });
    }
    const emulatorDevices = await Promise.all(emulatorAdbs.map(installation =>
      listDevicesFromAdb(installation.adbPath, installation)
    ));
    const devices = mergeDiscoveredDevices(configuredDevices, emulatorDevices);
    const knownAddresses = new Set(devices.map(device => device.address));
    const reachable = await Promise.all(LOCAL_EMULATOR_ADDRESSES.map(async address => ({
      address,
      reachable: await probeLocalAddress(address)
    })));
    const candidates: AdbDevice[] = reachable
      .filter(candidate => candidate.reachable && !knownAddresses.has(candidate.address))
      .map(candidate => ({
        address: candidate.address,
        state: 'candidate',
        details: '发现可尝试连接的本机模拟器端口',
        source: 'local-port'
      }));

    const count = devices.length + candidates.length;
    const installationNote = emulatorAdbs.length && count === 0
      ? `，已发现 ${emulatorAdbs.length} 个模拟器内置 ADB`
      : '';
    return {
      success: true,
      adbAvailable: true,
      message: count ? `找到 ${count} 个设备或可尝试地址` : `未找到已连接的模拟器${installationNote}`,
      devices,
      candidates,
      adbInstallations: emulatorAdbs
    };
  } catch (error) {
    return {
      success: false,
      adbAvailable: true,
      message: '查找设备失败',
      devices: [],
      candidates: [],
      error: errorMessageOf(error)
    };
  }
}

export async function getGameClientState(
  adbPath: unknown = DEFAULT_ADB_PATH,
  address: unknown = DEFAULT_ADB_ADDRESS,
  clientType: string = DEFAULT_CLIENT_TYPE
): Promise<GameClientState> {
  const executable = validateAdbPath(adbPath);
  const deviceAddress = validateAdbAddress(address);

  const expectedPackage = GAME_PACKAGES[clientType] || GAME_PACKAGES.Official;
  const { stdout } = await adbExecText(executable, ['-s', deviceAddress, 'shell', 'dumpsys', 'window']);
  const foregroundPackage = parseForegroundPackage(stdout);

  return {
    running: foregroundPackage === expectedPackage,
    expectedPackage,
    foregroundPackage
  };
}

export function parseForegroundPackage(output: unknown = ''): string | null {
  const lines = String(output).split('\n');
  const focusLine = lines.find(line => line.includes('mCurrentFocus'))
    || lines.find(line => line.includes('mFocusedApp'))
    || '';
  const packageMatch = focusLine.match(/\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/);
  return packageMatch?.[1] || null;
}

/**
 * 测试 ADB 连接
 */
export async function testAdbConnection(
  adbPath: unknown = DEFAULT_ADB_PATH,
  address: unknown = DEFAULT_ADB_ADDRESS
): Promise<AdbConnectionResult> {
  try {
    // 检查 ADB 是否可用
    try {
      await adbExecText(adbPath, ['version'], { timeout: 5000, windowsHide: true });
    } catch (error) {
      return {
        success: false,
        message: `ADB 不可用，请检查 ADB 路径：${errorMessageOf(error)}`,
        error: errorMessageOf(error)
      };
    }

    // 检查设备列表
    const deviceAddress = validateAdbAddress(address);
    const { stdout: devicesOutput } = await adbExecText(adbPath, ['devices'], { timeout: 6000, windowsHide: true });
    const deviceState = getAdbDeviceState(devicesOutput, deviceAddress);

    if (deviceState === 'device') {
      return {
        success: true,
        message: `已连接到 ${deviceAddress}`,
        connected: true
      };
    }

    if (deviceState === 'unauthorized') {
      return {
        success: false,
        message: `设备 ${deviceAddress} 未授权，请在模拟器中允许 USB 调试`,
        connected: false
      };
    }

    if (deviceState === 'offline') {
      return {
        success: false,
        message: `设备 ${deviceAddress} 已离线，请重启模拟器或 ADB`,
        connected: false
      };
    }

    // 尝试连接
    logger.debug('尝试连接设备', { address: deviceAddress });
    const { stdout: connectOutput } = await adbExecText(adbPath, ['connect', deviceAddress], { timeout: 8000, windowsHide: true });

    // 等待连接稳定
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 再次检查连接状态
    const { stdout: devicesOutput2 } = await adbExecText(adbPath, ['devices'], { timeout: 6000, windowsHide: true });
    const currentDeviceState = getAdbDeviceState(devicesOutput2, deviceAddress);

    if (currentDeviceState === 'device') {
      return {
        success: true,
        message: `成功连接到 ${deviceAddress}`,
        connected: true
      };
    }

    const stateMessage = currentDeviceState === 'unauthorized'
      ? `设备 ${deviceAddress} 未授权，请在模拟器中允许 USB 调试`
      : currentDeviceState === 'offline'
        ? `设备 ${deviceAddress} 已离线，请重启模拟器或 ADB`
        : `无法连接到 ${deviceAddress}，请确保模拟器已启动`;
    return {
      success: false,
      message: stateMessage,
      connected: false,
      output: connectOutput
    };
  } catch (error) {
    return {
      success: false,
      message: `连接测试失败：${errorMessageOf(error)}`,
      error: errorMessageOf(error)
    };
  }
}

/**
 * 通过 ADB 截取模拟器屏幕
 */
export async function captureScreen(
  adbPath: unknown = DEFAULT_ADB_PATH,
  address: unknown = DEFAULT_ADB_ADDRESS
): Promise<CapturedScreen> {
  let step = '检查设备';
  let timeoutMs = 3000;
  try {
    const executable = validateAdbPath(adbPath);
    const deviceAddress = validateAdbAddress(address);

    // 先检查设备是否已连接
    const { stdout: devicesOutput } = await adbExecText(executable, ['devices'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true
    });
    const isConnected = devicesOutput.includes(deviceAddress);

    if (!isConnected) {
      logger.debug('设备未连接，尝试连接', { address: deviceAddress });
      step = '连接设备';
      timeoutMs = 5000;
      const { stdout: connectOutput, stderr: connectError } = await adbExecText(executable, ['connect', deviceAddress], {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true
      });
      logger.debug('连接结果', { output: connectOutput });

      if (connectError) {
        logger.warn('连接警告', { error: connectError });
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.debug('执行截图命令', { adbPath: executable, address: deviceAddress });
    step = '读取屏幕画面';
    timeoutMs = 8000;
    const { stdout, stderr } = await adbExecBuffer(executable, ['-s', deviceAddress, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true
    });

    if (stderr && stderr.length) {
      logger.warn('截图警告', { error: stderr.toString() });
    }

    return {
      image: Buffer.from(stdout).toString('base64'),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const details: Record<string, unknown> = isRecord(error) ? error : {};
    if (details.killed === true && details.signal === 'SIGKILL') {
      throw new Error(`截图失败: ${step}超时（${timeoutMs}ms）`, { cause: error });
    }
    throw new Error(`截图失败: ${errorMessageOf(error)}`);
  }
}
