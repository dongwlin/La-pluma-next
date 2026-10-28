import express from 'express';
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
  getWebrtcDevices,
  DEFAULT_DEVICE_ID
} from '../services/webrtcService.ts';
import { getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendDryRun
} from '../utils/apiHelper.ts';
import { resolveRequestConnection } from './requestConnection.js';
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.ts';

/**
 * 设备预览路由：截图、WebRTC 启停与状态、方向设置和设备采样。
 *
 * 这里只做 HTTP 适配：截图调用 maaDeviceService 的既有用例，WebRTC 进程、
 * viewer 计时器、启动队列和资源所有权仍由 webrtcService/webrtcRuntime
 * 持有，方向设置复用同一 ADB 命令计划，设备采样只读 ADB。router 不缓存
 * 运行状态、不另建子进程或租约；预览与截图按现行契约不参与设备自动化
 * 执行租约。浏览器实时预览继续经过同源 `/webrtc-signaling` 网关，上游
 * 管理端点不外露。
 */
const router = express.Router();
const execFileAsync = promisify(execFile);

export function buildWebrtcBrowserProtocol(deviceId) {
  return {
    websocket: `${WEBRTC_SIGNALING_PATH}/connect_client?token=`,
    connectMessage: { message_type: 'connect', device_id: deviceId },
    requestOfferPayload: { type: 'request-offer', ip_preference: 'ipv4' },
    candidatePolicy: 'relay preferred / ipv4'
  };
}

function pngDimensions(base64) {
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

function buildOrientationPlan({ orientation, adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS } = {}) {
  const normalized = String(orientation || '').trim().toLowerCase();
  const rotationByOrientation = { portrait: '0', landscape: '1' };

  if (!['portrait', 'landscape', 'auto'].includes(normalized)) {
    throw agentError('AGENT_VALIDATION_ORIENTATION_INVALID', 'orientation 必须是 portrait、landscape 或 auto', {
      statusCode: 400,
      details: { orientation },
      retryable: false
    });
  }

  const commands = normalized === 'auto'
    ? [
        ['settings', 'put', 'system', 'accelerometer_rotation', '1']
      ]
    : [
        ['settings', 'put', 'system', 'accelerometer_rotation', '0'],
        ['settings', 'put', 'system', 'user_rotation', rotationByOrientation[normalized]],
        ['cmd', 'window', 'set-user-rotation', 'lock', rotationByOrientation[normalized]]
      ];

  return {
    action: 'preview-orientation',
    orientation: normalized,
    adbPath,
    address,
    commands: commands.map(args => ({ command: adbPath, args: ['-s', address, 'shell', ...args] }))
  };
}

async function setAndroidOrientation(options = {}) {
  const plan = buildOrientationPlan(options);
  const results = [];

  for (const item of plan.commands) {
    try {
      const { stdout, stderr } = await execFileAsync(item.command, item.args, { timeout: 7000, maxBuffer: 256 * 1024 });
      results.push({ ok: true, args: item.args, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (error) {
      const optionalCmdWindow = item.args.includes('cmd') && item.args.includes('window') && item.args.includes('set-user-rotation');
      results.push({ ok: optionalCmdWindow, optional: optionalCmdWindow, args: item.args, error: error.message, stdout: (error.stdout || '').trim(), stderr: (error.stderr || '').trim() });
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

router.post('/screen/screenshot', asyncHandler(async (req, res) => {
  const { adbPath, address, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const screenshot = await captureScreen(adbPath, address);
  return sendSuccess(res, req, {
    ...screenshot,
    ...pngDimensions(screenshot.image),
    mediaType: 'image/png',
    adbPath,
    address,
    profileId
  });
}));

router.get('/webrtc/status', asyncHandler(async (req, res) => {
  const { address, adbPath, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const summary = await getWebrtcSummary(address, adbPath);
  return sendSuccess(res, req, { ...summary, profileId, devices: await getWebrtcDevices() });
}));

router.get('/webrtc/devices', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, { devices: await getWebrtcDevices() });
}));

router.post('/webrtc/start', asyncHandler(async (req, res) => {
  const { address, adbPath, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const deviceId = req.body?.deviceId || DEFAULT_DEVICE_ID;
  const status = await startWebrtc(address, deviceId, adbPath);
  const summary = await getWebrtcSummary(address, adbPath);
  return sendSuccess(res, req, {
    ...summary,
    ...status,
    devices: await getWebrtcDevices(),
    deviceId,
    address,
    profileId,
    protocol: buildWebrtcBrowserProtocol(deviceId)
  });
}));

router.post('/webrtc/stop', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  return sendSuccess(res, req, await stopWebrtc(address, adbPath));
}));

router.post('/preview/orientation', asyncHandler(async (req, res) => {
  const { orientation, dryRun = false } = req.body || {};
  const { adbPath, address } = await resolveRequestConnection(req, { allowOverrides: true })
  const plan = buildOrientationPlan({ orientation, adbPath, address });

  if (dryRun) {
    return sendDryRun(res, req, plan);
  }

  return sendSuccess(res, req, await setAndroidOrientation({ orientation, adbPath, address }), '屏幕方向已设置');
}));

router.post('/webrtc/install', asyncHandler(async (req, res) => {
  const result = await installWebrtc();
  return sendSuccess(res, req, result, 'WebRTC 组件已安装');
}));

router.post('/webrtc/start-server', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await startWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已启动');
}));

router.post('/webrtc/stop-server', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await stopWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已停止');
}));

router.post('/webrtc/start-agent', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const deviceId = req.body?.deviceId || DEFAULT_DEVICE_ID;
  const result = await startWebrtcAgent(address, deviceId, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已启动');
}));

router.post('/webrtc/stop-agent', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await stopWebrtcAgent(address, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已停止');
}));

async function getDeviceStats(adbPath, address) {
  try {
    const cmd = (c) => execFileAsync(adbPath, ['-s', address, 'shell', c], { timeout: 5000, maxBuffer: 256 * 1024 })
    const [loadRaw, memRaw, diskRaw, tempRaw, topRaw] = await Promise.all([
      cmd('cat /proc/loadavg'),
      cmd('cat /proc/meminfo | head -4'),
      cmd('df -h /data | tail -1'),
      cmd('dumpsys battery | grep temperature'),
      cmd('top -b -n 1 -d 0.3 | head -5'),
    ])

    // CPU load from /proc/loadavg
    const loadParts = loadRaw.stdout.trim().split(/\s+/)
    // CPU usage % from top output: "400%cpu  0%user ... 396%idle"
    const topTotal = topRaw.stdout.match(/(\d+)%cpu/i)
    const topIdle  = topRaw.stdout.match(/(\d+)%idle/i)
    const cpuPct = topTotal && topIdle ? Math.round(((parseInt(topTotal[1]) - parseInt(topIdle[1])) / parseInt(topTotal[1])) * 100) : null
    // Memory from /proc/meminfo (kB)
    const memInfo = {};
    for (const line of memRaw.stdout.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) memInfo[m[1]] = parseInt(m[2]);
    }
    const memTotalKb = memInfo['MemTotal'] || 0;
    const memFreeKb  = memInfo['MemFree'] || 0;
    const memAvailKb = memInfo['MemAvailable'] || 0;
    const memUsedKb  = memTotalKb - (memAvailKb || memFreeKb);
    const swapTotalKb = memInfo['SwapTotal'] || 0;
    const swapUsedKb  = swapTotalKb - (memInfo['SwapFree'] || 0);
    const diskParts = diskRaw.stdout.trim().split(/\s+/)
    const tempMatch = tempRaw.stdout.match(/temperature:\s*(\d+)/)

    const fmtMb = (kb) => kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`

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

router.get('/device-stats', asyncHandler(async (req, res) => {
  const { adbPath, address } = await resolveRequestConnection(req, { allowOverrides: true })
  const stats = await getDeviceStats(adbPath, address);
  return sendSuccess(res, req, stats);
}));

export default router;
