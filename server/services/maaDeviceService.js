import { execFile } from 'node:child_process';
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

const LOCAL_EMULATOR_ADDRESSES = [
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
];
const GAME_PACKAGES = {
  Official: 'com.hypergryph.arknights',
  Bilibili: 'com.hypergryph.arknights.bilibili',
  YoStarEN: 'com.YoStarEN.Arknights',
  YoStarJP: 'com.YoStarJP.Arknights',
  YoStarKR: 'com.YoStarKR.Arknights',
  Txwy: 'tw.txwy.and.arknights'
};

function validateAdbPath(adbPath) {
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

function validateAdbAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error('ADB 地址不能为空');
  }
  // 常见形态：127.0.0.1:5555、192.168.1.2:5555、localhost:5555、emulator-5554
  if (!/^([a-zA-Z0-9_.-]+)(:\d{1,5})?$/.test(address)) {
    throw new Error('ADB 地址格式不合法');
  }
  return address;
}

async function adbExec(adbPath, args, options = {}) {
  validateAdbPath(adbPath);
  return execFilePromise(adbPath, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...options
  });
}

function parseAdbDeviceList(output = '') {
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
        state: ['device', 'offline', 'unauthorized'].includes(state) ? state : 'unknown',
        details: details || attributes.join(' '),
        source: 'adb'
      };
    })
    .filter(device => device.address);
}

export function getAdbDeviceState(output, address) {
  return parseAdbDeviceList(output).find(device => device.address === address)?.state || null;
}

function probeLocalAddress(address, timeout = 280) {
  const [host, portValue] = address.split(':');
  const port = Number(portValue);
  if (!host || !Number.isInteger(port)) return Promise.resolve(false);

  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const complete = (reachable) => {
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

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function findWindowsEmulatorSpec(processName = '') {
  const normalizedName = String(processName).toLowerCase();
  return WINDOWS_EMULATOR_PROCESSES.find(spec =>
    spec.names.some(name => name.toLowerCase() === normalizedName)
  );
}

async function getWindowsEmulatorProcesses() {
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
    ], { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = stdout.trim();
    if (!output) return [];
    const entries = JSON.parse(output);
    return (Array.isArray(entries) ? entries : [entries])
      .filter(entry => entry?.Name && entry?.ExecutablePath)
      .map(entry => ({
        name: String(entry.Name),
        executablePath: String(entry.ExecutablePath)
      }));
  } catch (error) {
    logger.debug('Windows 模拟器进程扫描失败', { error: error.message });
    return [];
  }
}

async function discoverWindowsEmulatorAdbs() {
  const processes = await getWindowsEmulatorProcesses();
  const seenPaths = new Set();
  const installations = [];

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

async function listDevicesFromAdb(adbPath, metadata = {}) {
  try {
    const { stdout } = await adbExec(adbPath, ['devices', '-l'], { timeout: 6000, windowsHide: true });
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
    logger.debug('读取模拟器内置 ADB 设备失败', { adbPath, error: error.message });
    return [];
  }
}

function mergeDiscoveredDevices(...deviceGroups) {
  const devicesByAddress = new Map();
  for (const device of deviceGroups.flat()) {
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
export async function discoverAdbDevices(adbPath = DEFAULT_ADB_PATH) {
  let configuredAdbAvailable = true;
  try {
    await adbExec(adbPath, ['version']);
  } catch (error) {
    configuredAdbAvailable = false;
    logger.debug('当前 ADB 不可用，继续查找 Windows 模拟器内置 ADB', { adbPath, error: error.message });
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

    const configuredDevices = configuredAdbAvailable
      ? await listDevicesFromAdb(adbPath, { adbPath, label: '当前 ADB', source: 'adb' })
      : [];
    const emulatorDevices = await Promise.all(emulatorAdbs.map(installation =>
      listDevicesFromAdb(installation.adbPath, installation)
    ));
    const devices = mergeDiscoveredDevices(configuredDevices, emulatorDevices);
    const knownAddresses = new Set(devices.map(device => device.address));
    const reachable = await Promise.all(LOCAL_EMULATOR_ADDRESSES.map(async address => ({
      address,
      reachable: await probeLocalAddress(address)
    })));
    const candidates = reachable
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
      error: error.message
    };
  }
}

export async function getGameClientState(
  adbPath = DEFAULT_ADB_PATH,
  address = DEFAULT_ADB_ADDRESS,
  clientType = DEFAULT_CLIENT_TYPE
) {
  validateAdbPath(adbPath);
  validateAdbAddress(address);

  const expectedPackage = GAME_PACKAGES[clientType] || GAME_PACKAGES.Official;
  const { stdout } = await adbExec(adbPath, ['-s', address, 'shell', 'dumpsys', 'window']);
  const foregroundPackage = parseForegroundPackage(stdout);

  return {
    running: foregroundPackage === expectedPackage,
    expectedPackage,
    foregroundPackage
  };
}

export function parseForegroundPackage(output = '') {
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
export async function testAdbConnection(adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS) {
  try {
    // 检查 ADB 是否可用
    try {
      await adbExec(adbPath, ['version'], { timeout: 5000, windowsHide: true });
    } catch (error) {
      return {
        success: false,
        message: `ADB 不可用，请检查 ADB 路径：${error.message}`,
        error: error.message
      };
    }

    // 检查设备列表
    validateAdbAddress(address);
    const { stdout: devicesOutput } = await adbExec(adbPath, ['devices'], { timeout: 6000, windowsHide: true });
    const deviceState = getAdbDeviceState(devicesOutput, address);

    if (deviceState === 'device') {
      return {
        success: true,
        message: `已连接到 ${address}`,
        connected: true
      };
    }

    if (deviceState === 'unauthorized') {
      return {
        success: false,
        message: `设备 ${address} 未授权，请在模拟器中允许 USB 调试`,
        connected: false
      };
    }

    if (deviceState === 'offline') {
      return {
        success: false,
        message: `设备 ${address} 已离线，请重启模拟器或 ADB`,
        connected: false
      };
    }

    // 尝试连接
    logger.debug('尝试连接设备', { address });
    const { stdout: connectOutput } = await adbExec(adbPath, ['connect', address], { timeout: 8000, windowsHide: true });

    // 等待连接稳定
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 再次检查连接状态
    const { stdout: devicesOutput2 } = await adbExec(adbPath, ['devices'], { timeout: 6000, windowsHide: true });
    const currentDeviceState = getAdbDeviceState(devicesOutput2, address);

    if (currentDeviceState === 'device') {
      return {
        success: true,
        message: `成功连接到 ${address}`,
        connected: true
      };
    }

    const stateMessage = currentDeviceState === 'unauthorized'
      ? `设备 ${address} 未授权，请在模拟器中允许 USB 调试`
      : currentDeviceState === 'offline'
        ? `设备 ${address} 已离线，请重启模拟器或 ADB`
        : `无法连接到 ${address}，请确保模拟器已启动`;
    return {
      success: false,
      message: stateMessage,
      connected: false,
      output: connectOutput
    };
  } catch (error) {
    return {
      success: false,
      message: `连接测试失败：${error.message}`,
      error: error.message
    };
  }
}

/**
 * 通过 ADB 截取模拟器屏幕
 */
export async function captureScreen(adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS) {
  let step = '检查设备';
  let timeoutMs = 3000;
  try {
    validateAdbPath(adbPath);
    validateAdbAddress(address);

    // 先检查设备是否已连接
    const { stdout: devicesOutput } = await adbExec(adbPath, ['devices'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true
    });
    const isConnected = devicesOutput.includes(address);

    if (!isConnected) {
      logger.debug('设备未连接，尝试连接', { address });
      step = '连接设备';
      timeoutMs = 5000;
      const { stdout: connectOutput, stderr: connectError } = await adbExec(adbPath, ['connect', address], {
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

    logger.debug('执行截图命令', { adbPath, address });
    step = '读取屏幕画面';
    timeoutMs = 8000;
    const { stdout, stderr } = await adbExec(adbPath, ['-s', address, 'exec-out', 'screencap', '-p'], {
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
    if (error.killed && error.signal === 'SIGKILL') {
      throw new Error(`截图失败: ${step}超时（${timeoutMs}ms）`, { cause: error });
    }
    throw new Error(`截图失败: ${error.message}`);
  }
}
