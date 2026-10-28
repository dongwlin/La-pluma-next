import { execFile } from 'child_process';
import { promisify } from 'util';
import { testAdbConnection } from '../services/maaDeviceService.ts';
import {
  getWebrtcStatus,
  isWebrtcServerReachable,
  DEFAULT_DEVICE_ADDRESS,
  WEBRTC_PORT
} from '../services/webrtcService.ts';
import type { WebrtcStatus } from '../services/webrtcService.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';

/**
 * 设备状态读取适配：ADB 摘要、WebRTC 摘要与 Android 显示状态。
 *
 * 这些函数不是无副作用的纯读取：ADB 摘要会运行 `adb version`/`devices`，
 * 并在设备未就绪时执行 `adb connect`；显示状态会执行 adb shell；WebRTC
 * 摘要会探测本地服务端口。`/status` 汇总与预览方向观测共用同一适配，
 * 调用方不能把探测结果当作设备空闲或执行成功的证据。
 *
 * 三个投影各自独立：ADB 摘要只描述连接与前台窗口，显示状态只描述屏幕与
 * 方向，WebRTC 摘要只描述本地服务；任何一项都不能替代 Run、进程或租约。
 */
const execFileAsync = promisify(execFile);

/** ADB 摘要；连接失败时 connected 为 false，message 保留探测文本。 */
export interface AdbSummary {
  adbPath: string;
  address: string;
  connected: boolean;
  message: string;
  /** mCurrentFocus/mFocusedApp 行；未连接或读取失败时为 null。 */
  foreground: string | null;
  /** `adb devices -l` 的原始列表；命令失败时保留失败文本。 */
  devices: string;
}

/**
 * WebRTC 摘要：本地状态探测的快照加可达性与提示。
 * 探测失败时仅保留 url 与布尔兜底，其余上游状态字段可能缺省。
 */
export interface WebrtcSummary extends Partial<WebrtcStatus> {
  url: string;
  reachable: boolean;
  serverRunning: boolean;
  agentRunning: boolean;
  installed: boolean;
  built: boolean;
  note: string;
}

/** 只有宽高都可读时才推导方向，读不到时为 null。 */
export type InferredOrientation = 'landscape' | 'portrait' | null;

/** Android 显示与方向观测；读取失败的字段保持 null，不补造未知值。 */
export interface AndroidDisplayState {
  adbPath: string;
  address: string;
  rotation: number | null;
  accelerometerRotation: string | null;
  userRotation: string | null;
  width: number | null;
  height: number | null;
  inferredOrientation: InferredOrientation;
}

/** 子进程输出在类型层可能是 Buffer；实际运行按 utf8 文本读取。 */
function readExecText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

/** execFile 的拒绝值为 Error；其它值按文本归一，保留既有失败文案前缀。 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getAdbSummary(
  adbPath: string = DEFAULT_ADB_PATH,
  address: string = DEFAULT_ADB_ADDRESS
): Promise<AdbSummary> {
  const connection = await testAdbConnection(adbPath, address);
  let foreground: string | null = null;
  let devices = '';

  try {
    const { stdout } = await execFileAsync(adbPath, ['devices', '-l'], { timeout: 5000 });
    devices = readExecText(stdout).trim();
  } catch (error) {
    devices = `adb devices failed: ${errorMessageOf(error)}`;
  }

  if (connection.connected || connection.success) {
    try {
      const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'dumpsys', 'window', 'windows'], { timeout: 7000, maxBuffer: 1024 * 1024 });
      const focusLine = readExecText(stdout).split('\n').find(line => line.includes('mCurrentFocus') || line.includes('mFocusedApp')) || '';
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

export async function getWebrtcSummary(
  address: string = DEFAULT_DEVICE_ADDRESS,
  adbPath: string = DEFAULT_ADB_PATH
): Promise<WebrtcSummary> {
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

export async function getAndroidDisplayState(
  adbPath: string = DEFAULT_ADB_PATH,
  address: string = DEFAULT_ADB_ADDRESS
): Promise<AndroidDisplayState> {
  const readSetting = async (name: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'settings', 'get', 'system', name], { timeout: 5000 });
      return readExecText(stdout).trim();
    } catch {
      return null;
    }
  };

  let display = '';
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', 'dumpsys', 'display'], { timeout: 7000, maxBuffer: 512 * 1024 });
    display = readExecText(stdout);
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
