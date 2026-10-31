import { execFile } from 'child_process';
import { promisify } from 'util';
import { captureScreen } from '../services/maaDeviceService.ts';
import {
  installWebrtc,
  startWebrtcServer,
  stopWebrtcServer,
  startWebrtcAgent,
  stopWebrtcAgent,
  startWebrtc,
  stopWebrtc,
  getWebrtcDevices
} from '../services/webrtcService.ts';
import { getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.ts';
import {
  agentError,
  sendSuccess,
  sendDryRun
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';
import {
  parseDeviceIdBody,
  parseOrientationBody,
  resolvePreviewConnection
} from './previewDto.ts';
import type {
  PngDimensions,
  PreviewDeviceStats,
  PreviewOrientation,
  PreviewOrientationApplyResult,
  PreviewOrientationCommandResult,
  PreviewOrientationPlan,
  PreviewRequest,
  PreviewScreenshotPayload,
  PreviewWebrtcDevicesPayload,
  PreviewWebrtcProtocol,
  PreviewWebrtcStartPayload,
  PreviewWebrtcStatusPayload
} from './previewDto.ts';

/**
 * 设备预览控制器：截图、WebRTC 启停与状态、方向设置和设备采样。
 *
 * 这里只做 HTTP 适配：截图调用 maaDeviceService 的既有用例，WebRTC 进程、
 * viewer 计时器、启动队列和资源所有权仍由 webrtcService/webrtcRuntime
 * 持有，方向设置复用同一 ADB 命令计划，设备采样只读 ADB。控制器不缓存
 * 运行状态、不另建子进程或租约；预览与截图按现行契约不参与设备自动化
 * 执行租约。浏览器实时预览继续经过同源 `/webrtc-signaling` 网关，上游
 * 管理端点不外露。
 *
 * 请求的未知值在 previewDto 按端点收窄（设备标识、方向/dryRun、连接
 * 选择各按既有规则）；响应载荷类型也由 previewDto 声明，错误继续经
 * 统一错误出口返回。路由层（agentPreviewRoutes.ts）只做端点映射；
 * req/res 解析、校验与成功/失败 envelope 都由本控制器的各 handler 装配。
 */
const execFileAsync = promisify(execFile);

const ORIENTATIONS: readonly PreviewOrientation[] = ['portrait', 'landscape', 'auto'];
const ROTATION_BY_ORIENTATION: Record<'portrait' | 'landscape', string> = {
  portrait: '0',
  landscape: '1'
};

export function buildWebrtcBrowserProtocol(deviceId: string): PreviewWebrtcProtocol {
  return {
    websocket: `${WEBRTC_SIGNALING_PATH}/connect_client?token=`,
    connectMessage: { message_type: 'connect', device_id: deviceId },
    requestOfferPayload: { type: 'request-offer', ip_preference: 'ipv4' },
    candidatePolicy: 'relay preferred / ipv4'
  };
}

function pngDimensions(base64: string): PngDimensions {
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
  } catch {
    // best-effort metadata only
  }
  return { width: null, height: null };
}

function isPreviewOrientation(value: string): value is PreviewOrientation {
  return (ORIENTATIONS as readonly string[]).includes(value);
}

interface OrientationPlanOptions {
  orientation?: unknown;
  adbPath?: string;
  address?: string;
}

function buildOrientationPlan({ orientation, adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS }: OrientationPlanOptions = {}): PreviewOrientationPlan {
  const normalized = String(orientation || '').trim().toLowerCase();

  if (!isPreviewOrientation(normalized)) {
    throw agentError('AGENT_VALIDATION_ORIENTATION_INVALID', 'orientation 必须是 portrait、landscape 或 auto', {
      statusCode: 400,
      details: { orientation },
      retryable: false
    });
  }

  const commands: string[][] = normalized === 'auto'
    ? [
        ['settings', 'put', 'system', 'accelerometer_rotation', '1']
      ]
    : [
        ['settings', 'put', 'system', 'accelerometer_rotation', '0'],
        ['settings', 'put', 'system', 'user_rotation', ROTATION_BY_ORIENTATION[normalized]],
        ['cmd', 'window', 'set-user-rotation', 'lock', ROTATION_BY_ORIENTATION[normalized]]
      ];

  return {
    action: 'preview-orientation',
    orientation: normalized,
    adbPath,
    address,
    commands: commands.map(args => ({ command: adbPath, args: ['-s', address, 'shell', ...args] }))
  };
}

/** 子进程输出在类型层可能是 Buffer；实际运行按 utf8 文本读取。 */
function readExecText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

interface ExecFailureText {
  message: string;
  stdout: string;
  stderr: string;
}

/** execFile 失败时读取既有字段；非错误对象按字符串消息归一。 */
function readExecFailure(error: unknown): ExecFailureText {
  if (typeof error === 'object' && error !== null) {
    const fields = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      message: typeof fields.message === 'string' ? fields.message : String(error),
      stdout: readExecText(fields.stdout),
      stderr: readExecText(fields.stderr)
    };
  }
  return { message: String(error), stdout: '', stderr: '' };
}

async function setAndroidOrientation(options: OrientationPlanOptions = {}): Promise<PreviewOrientationApplyResult> {
  const plan = buildOrientationPlan(options);
  const results: PreviewOrientationCommandResult[] = [];

  for (const item of plan.commands) {
    try {
      const { stdout, stderr } = await execFileAsync(item.command, item.args, { timeout: 7000, maxBuffer: 256 * 1024 });
      results.push({ ok: true, args: item.args, stdout: readExecText(stdout).trim(), stderr: readExecText(stderr).trim() });
    } catch (error) {
      const optionalCmdWindow = item.args.includes('cmd') && item.args.includes('window') && item.args.includes('set-user-rotation');
      const failure = readExecFailure(error);
      results.push({ ok: optionalCmdWindow, optional: optionalCmdWindow, args: item.args, error: failure.message, stdout: failure.stdout.trim(), stderr: failure.stderr.trim() });
      if (!optionalCmdWindow) throw error;
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  return {
    ...plan,
    results,
    observed: await getAndroidDisplayState(plan.adbPath, plan.address)
  };
}

export async function takeScreenshot(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { adbPath, address, profileId } = await resolvePreviewConnection(req);
  const screenshot = await captureScreen(adbPath, address);
  const payload: PreviewScreenshotPayload = {
    ...screenshot,
    ...pngDimensions(screenshot.image),
    mediaType: 'image/png',
    adbPath,
    address,
    profileId
  };
  return sendSuccess(res, req, payload);
}

export async function readWebrtcStatus(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath, profileId } = await resolvePreviewConnection(req);
  const summary = await getWebrtcSummary(address, adbPath);
  const payload: PreviewWebrtcStatusPayload = { ...summary, profileId, devices: await getWebrtcDevices() };
  return sendSuccess(res, req, payload);
}

export async function readWebrtcDevices(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const payload: PreviewWebrtcDevicesPayload = { devices: await getWebrtcDevices() };
  return sendSuccess(res, req, payload);
}

export async function startWebrtcPreview(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath, profileId } = await resolvePreviewConnection(req);
  const deviceId = parseDeviceIdBody(req.body);
  const status = await startWebrtc(address, deviceId, adbPath);
  const summary = await getWebrtcSummary(address, adbPath);
  const payload: PreviewWebrtcStartPayload = {
    ...summary,
    ...status,
    devices: await getWebrtcDevices(),
    deviceId,
    address,
    profileId,
    protocol: buildWebrtcBrowserProtocol(deviceId)
  };
  return sendSuccess(res, req, payload);
}

export async function stopWebrtcPreview(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath } = await resolvePreviewConnection(req);
  return sendSuccess(res, req, await stopWebrtc(address, adbPath));
}

export async function applyPreviewOrientation(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { orientation, dryRun } = parseOrientationBody(req.body);
  const { adbPath, address } = await resolvePreviewConnection(req);
  const plan = buildOrientationPlan({ orientation, adbPath, address });

  if (dryRun) {
    return sendDryRun(res, req, plan);
  }

  return sendSuccess(res, req, await setAndroidOrientation({ orientation, adbPath, address }), '屏幕方向已设置');
}

export async function installWebrtcComponents(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const result = await installWebrtc();
  return sendSuccess(res, req, result, 'WebRTC 组件已安装');
}

export async function startWebrtcServerProcess(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath } = await resolvePreviewConnection(req);
  const result = await startWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已启动');
}

export async function stopWebrtcServerProcess(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath } = await resolvePreviewConnection(req);
  const result = await stopWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已停止');
}

export async function startWebrtcAgentProcess(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath } = await resolvePreviewConnection(req);
  const deviceId = parseDeviceIdBody(req.body);
  const result = await startWebrtcAgent(address, deviceId, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已启动');
}

export async function stopWebrtcAgentProcess(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { address, adbPath } = await resolvePreviewConnection(req);
  const result = await stopWebrtcAgent(address, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已停止');
}

async function getDeviceStats(adbPath: string, address: string): Promise<PreviewDeviceStats | null> {
  try {
    const cmd = async (c: string): Promise<string> => {
      const { stdout } = await execFileAsync(adbPath, ['-s', address, 'shell', c], { timeout: 5000, maxBuffer: 256 * 1024 });
      return readExecText(stdout);
    };
    const [loadRaw, memRaw, diskRaw, tempRaw, topRaw] = await Promise.all([
      cmd('cat /proc/loadavg'),
      cmd('cat /proc/meminfo | head -4'),
      cmd('df -h /data | tail -1'),
      cmd('dumpsys battery | grep temperature'),
      cmd('top -b -n 1 -d 0.3 | head -5'),
    ]);

    // CPU load from /proc/loadavg
    const loadParts = loadRaw.trim().split(/\s+/)
    // CPU usage % from top output: "400%cpu  0%user ... 396%idle"
    const topTotal = topRaw.match(/(\d+)%cpu/i)
    const topIdle  = topRaw.match(/(\d+)%idle/i)
    const cpuPct = topTotal && topIdle ? Math.round(((parseInt(topTotal[1]) - parseInt(topIdle[1])) / parseInt(topTotal[1])) * 100) : null
    // Memory from /proc/meminfo (kB)
    const memInfo: Record<string, number> = {};
    for (const line of memRaw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) memInfo[m[1]] = parseInt(m[2]);
    }
    const memTotalKb = memInfo['MemTotal'] || 0;
    const memFreeKb  = memInfo['MemFree'] || 0;
    const memAvailKb = memInfo['MemAvailable'] || 0;
    const memUsedKb  = memTotalKb - (memAvailKb || memFreeKb);
    const swapTotalKb = memInfo['SwapTotal'] || 0;
    const swapUsedKb  = swapTotalKb - (memInfo['SwapFree'] || 0);
    const diskParts = diskRaw.trim().split(/\s+/)
    const tempMatch = tempRaw.match(/temperature:\s*(\d+)/)

    const fmtMb = (kb: number): string => kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`

    return {
      load1m: loadParts[0] ? parseFloat(loadParts[0]) : null,
      load5m: loadParts[1] ? parseFloat(loadParts[1]) : null,
      load15m: loadParts[2] ? parseFloat(loadParts[2]) : null,
      cpuPct,
      memTotalKb, memUsedKb, memFreeKb: memAvailKb || memFreeKb,
      memTotal: fmtMb(memTotalKb),
      memUsed:  fmtMb(memUsedKb),
      memFree:  fmtMb(memAvailKb || memFreeKb),
      memPct: memTotalKb ? Math.round((memUsedKb / memTotalKb) * 100) : null,
      swapTotalKb,
      swapUsedKb,
      diskTotal: diskParts[1] || null,
      diskUsed:  diskParts[2] || null,
      diskFree:  diskParts[3] || null,
      diskPct:   diskParts[4] ? parseInt(diskParts[4]) : null,
      temp: tempMatch ? parseInt(tempMatch[1]) / 10 : null,
    }
  } catch { return null }
}

export async function readDeviceStats(req: PreviewRequest, res: ApiResponseWriter): Promise<void> {
  const { adbPath, address } = await resolvePreviewConnection(req);
  const stats = await getDeviceStats(adbPath, address);
  return sendSuccess(res, req, stats);
}
