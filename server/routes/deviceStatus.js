import { execFile } from 'child_process';
import { promisify } from 'util';
import { testAdbConnection } from '../services/maaDeviceService.js';
import {
  getWebrtcStatus,
  isWebrtcServerReachable,
  DEFAULT_DEVICE_ADDRESS,
  WEBRTC_PORT
} from '../services/webrtcService.js';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.js';

/**
 * 设备状态读取适配：ADB 摘要、WebRTC 摘要与 Android 显示状态。
 *
 * 这些函数不是无副作用的纯读取：ADB 摘要会运行 `adb version`/`devices`，
 * 并在设备未就绪时执行 `adb connect`；显示状态会执行 adb shell；WebRTC
 * 摘要会探测本地服务端口。`/status` 汇总与预览方向观测共用同一适配，
 * 调用方不能把探测结果当作设备空闲或执行成功的证据。
 */
const execFileAsync = promisify(execFile);

export async function getAdbSummary(adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS) {
  const connection = await testAdbConnection(adbPath, address);
  let foreground = null;
  let devices = '';

  try {
    const { stdout } = await execFileAsync(adbPath, ['devices', '-l'], { timeout: 5000 });
    devices = stdout.trim();
  } catch (error) {
    devices = `adb devices failed: ${error.message}`;
  }

  if (connection.connected || connection.success) {
    try {
      const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'dumpsys', 'window', 'windows'], { timeout: 7000, maxBuffer: 1024 * 1024 });
      const focusLine = stdout.split('\n').find(line => line.includes('mCurrentFocus') || line.includes('mFocusedApp')) || '';
      foreground = focusLine.trim() || null;
    } catch {
      foreground = null;
    }
  }

  return {
    adbPath,
    address,
    connected: !!(connection.connected || connection.success),
    message: connection.message,
    foreground,
    devices
  };
}

export async function getWebrtcSummary(address = DEFAULT_DEVICE_ADDRESS, adbPath = DEFAULT_ADB_PATH) {
  const [status, reachable] = await Promise.all([
    getWebrtcStatus(address, adbPath).catch(() => null),
    isWebrtcServerReachable()
  ])
  return {
    ...(status || {}),
    url: status?.url || `http://127.0.0.1:${WEBRTC_PORT}`,
    reachable,
    serverRunning: Boolean(status?.serverRunning || reachable),
    agentRunning: Boolean(status?.agentRunning),
    installed: Boolean(status?.installed),
    built: Boolean(status?.built),
    note: reachable ? 'WebRTC page is reachable. Use browser UI to connect the device.' : 'WebRTC page is not reachable. Start it from /api/agent/webrtc/start or the Web UI.'
  }
}

export async function getAndroidDisplayState(adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS) {
  const readSetting = async (name) => {
    try {
      const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'settings', 'get', 'system', name], { timeout: 5000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  let display = '';
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'dumpsys', 'display'], { timeout: 7000, maxBuffer: 512 * 1024 });
    display = stdout;
  } catch {
    display = '';
  }

  const rotationMatch = display.match(/mCurrentOrientation\s*=\s*(\d+)/)
    || display.match(/mDisplayInfo=.*?rotation\s+(\d+)/)
    || display.match(/rotation\s*=\s*(\d+)/i);
  const sizeMatch = display.match(/real\s+(\d+)\s+x\s+(\d+)/i)
    || display.match(/logicalWidth=(\d+).*?logicalHeight=(\d+)/s);
  const width = sizeMatch ? Number(sizeMatch[1]) : null;
  const height = sizeMatch ? Number(sizeMatch[2]) : null;

  return {
    adbPath,
    address,
    rotation: rotationMatch ? Number(rotationMatch[1]) : null,
    accelerometerRotation: await readSetting('accelerometer_rotation'),
    userRotation: await readSetting('user_rotation'),
    width,
    height,
    inferredOrientation: width && height ? (width > height ? 'landscape' : 'portrait') : null
  };
}
